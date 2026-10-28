import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
} from 'aws-cdk-lib';
import type * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';
import {
  composeDevFunction,
  composePreviewFunction,
  composeProductionFunction,
} from './compose-function.js';
import {
  COM_DOMAIN,
  DATA_BUCKET,
  DATA_NONCURRENT_VERSION_DAYS,
  DEV_HOSTNAME,
  DEV_SITE_BUCKET,
  PREVIEW_EXPIRY_DAYS,
  PREVIEW_HOSTNAME,
  PREVIEW_SITE_BUCKET,
  PROD_HOSTNAMES,
  SITE_BUCKET,
} from './config.js';

export interface WebStackProps extends StackProps {
  orgZone: route53.IHostedZone;
  comZone: route53.IHostedZone;
  certificate: acm.ICertificate;
}

// Paths the browser fetches that live in the data bucket. `data/*` is for the
// dashboard host, where the request arrives as /data/... and the function
// rewrites it to /simple/data/...; CloudFront picks the behavior before the
// function runs and does not re-match afterwards. alerts/data/* is still
// written by the daily pipeline and holds the building footprints the simple
// page loads, although the SIREN dashboard itself went offline on 2026-10-22.
const DATA_PATHS = ['alerts/data/*', 'simple/data/*', 'data/*'];

// Site, data, dev-site and preview-site buckets with the production, dev and
// preview distributions. All in one stack because the dev and preview
// distributions read the production data bucket, and an origin access control across stacks would cycle through the
// bucket policy. Hostname records live here too, next to what they point at.
export class WebStack extends Stack {
  readonly siteBucket: s3.IBucket;
  readonly dataBucket: s3.IBucket;
  readonly devSiteBucket: s3.IBucket;
  readonly previewSiteBucket: s3.IBucket;
  readonly productionDistribution: cloudfront.IDistribution;
  readonly devDistribution: cloudfront.IDistribution;
  readonly previewDistribution: cloudfront.IDistribution;
  private readonly devAuthStore: cloudfront.IKeyValueStore;

  constructor(scope: Construct, id: string, props: WebStackProps) {
    super(scope, id, { terminationProtection: true, ...props });
    this.siteBucket = this.makeBucket('SiteBucket', SITE_BUCKET, false);
    this.dataBucket = this.makeBucket('DataBucket', DATA_BUCKET, true);
    this.devSiteBucket = this.makeBucket(
      'DevSiteBucket',
      DEV_SITE_BUCKET,
      false
    );
    this.previewSiteBucket = this.makeBucket(
      'PreviewSiteBucket',
      PREVIEW_SITE_BUCKET,
      false,
      PREVIEW_EXPIRY_DAYS
    );
    this.devAuthStore = this.makeDevAuthStore();

    this.productionDistribution = this.makeProductionDistribution(props);
    this.devDistribution = this.makeDevDistribution(props);
    this.previewDistribution = this.makePreviewDistribution(props);

    this.makeRecords(props, [...PROD_HOSTNAMES], this.productionDistribution);
    this.makeRecords(props, [DEV_HOSTNAME], this.devDistribution);
    this.makeRecords(props, [PREVIEW_HOSTNAME], this.previewDistribution);
    this.makeOutputs();
  }

  // Values the cutover runbook (infra/README.md) and the workflows copy.
  private makeOutputs(): void {
    new CfnOutput(this, 'ProductionDistributionId', {
      value: this.productionDistribution.distributionId,
    });
    new CfnOutput(this, 'ProductionDomainName', {
      value: this.productionDistribution.distributionDomainName,
    });
    new CfnOutput(this, 'DevDistributionId', {
      value: this.devDistribution.distributionId,
    });
    new CfnOutput(this, 'DevDomainName', {
      value: this.devDistribution.distributionDomainName,
    });
    new CfnOutput(this, 'PreviewDistributionId', {
      value: this.previewDistribution.distributionId,
    });
    new CfnOutput(this, 'PreviewDomainName', {
      value: this.previewDistribution.distributionDomainName,
    });
    new CfnOutput(this, 'DevAuthStoreArn', {
      value: this.devAuthStore.keyValueStoreArn,
    });
  }

  // expireDays, when given, deletes every object that old; only the preview
  // bucket, whose contents are throwaway, sets it.
  private makeBucket(
    id: string,
    bucketName: string,
    versioned: boolean,
    expireDays?: number
  ): s3.IBucket {
    return new s3.Bucket(this, id, {
      bucketName,
      versioned,
      lifecycleRules: this.lifecycleRulesFor(versioned, expireDays),
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
  }

  private lifecycleRulesFor(
    versioned: boolean,
    expireDays?: number
  ): s3.LifecycleRule[] | undefined {
    const rules: s3.LifecycleRule[] = [];
    // A versioned bucket keeps every overwritten object until told
    // otherwise; status.json alone is rewritten 144 times a day. Expire old
    // versions after a while. Current objects, including the archive copies
    // of runs that flagged pathways under simple/archive/, are untouched.
    if (versioned) {
      rules.push({
        id: 'expire-noncurrent-versions',
        noncurrentVersionExpiration: Duration.days(
          DATA_NONCURRENT_VERSION_DAYS
        ),
      });
    }
    if (expireDays !== undefined) {
      rules.push({
        id: 'expire-objects',
        expiration: Duration.days(expireDays),
      });
    }
    return rules.length > 0 ? rules : undefined;
  }

  private makeProductionDistribution(
    props: WebStackProps
  ): cloudfront.IDistribution {
    const fn = new cloudfront.Function(this, 'ProductionFunction', {
      functionName: 'landslides-production',
      code: cloudfront.FunctionCode.fromInline(composeProductionFunction()),
      runtime: cloudfront.FunctionRuntime.JS_2_0,
    });
    return this.retained(
      new cloudfront.Distribution(this, 'ProductionDistribution', {
        comment:
          'landslidesncgs.org production site, dashboard, DFENS Simple, inventory and mapviewer hosts',
        domainNames: [...PROD_HOSTNAMES],
        certificate: props.certificate,
        minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
        defaultBehavior: this.makeBehavior(
          this.originFor(this.siteBucket),
          fn,
          true
        ),
        additionalBehaviors: this.makeDataBehaviors(fn, true),
      })
    );
  }

  // One credential guards the dev site and every preview site. The comment
  // still names only dev because changing it would replace the store and
  // drop the credential set by hand.
  private makeDevAuthStore(): cloudfront.IKeyValueStore {
    return new cloudfront.KeyValueStore(this, 'DevAuthStore', {
      keyValueStoreName: 'landslides-dev-basic-auth',
      comment:
        'basic-auth: base64 of user:password for dev.landslidesncgs.org (set by hand)',
    });
  }

  private makeDevDistribution(props: WebStackProps): cloudfront.IDistribution {
    const fn = new cloudfront.Function(this, 'DevFunction', {
      functionName: 'landslides-dev',
      code: cloudfront.FunctionCode.fromInline(composeDevFunction()),
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      keyValueStore: this.devAuthStore,
    });
    return this.retained(
      new cloudfront.Distribution(this, 'DevDistribution', {
        comment: 'dev.landslidesncgs.org, basic auth, reads production data',
        domainNames: [DEV_HOSTNAME],
        certificate: props.certificate,
        minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
        defaultBehavior: this.makeBehavior(
          this.originFor(this.devSiteBucket),
          fn,
          false
        ),
        additionalBehaviors: this.makeDataBehaviors(fn, false),
      })
    );
  }

  // Every open pull request into development, at <slug>.landslidesncgs.org.
  // The function maps the host onto the <slug>/ folder of the preview bucket.
  private makePreviewDistribution(
    props: WebStackProps
  ): cloudfront.IDistribution {
    const fn = new cloudfront.Function(this, 'PreviewFunction', {
      functionName: 'landslides-preview',
      code: cloudfront.FunctionCode.fromInline(composePreviewFunction()),
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      keyValueStore: this.devAuthStore,
    });
    return this.retained(
      new cloudfront.Distribution(this, 'PreviewDistribution', {
        comment:
          'Pull request previews at <branch>.landslidesncgs.org, basic auth, reads production data',
        domainNames: [PREVIEW_HOSTNAME],
        certificate: props.certificate,
        minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
        defaultBehavior: this.makeBehavior(
          this.originFor(this.previewSiteBucket),
          fn,
          false
        ),
        additionalBehaviors: this.makeDataBehaviors(fn, false),
      })
    );
  }

  // A distribution that CloudFormation drops is a live hostname gone; keep it.
  private retained(
    distribution: cloudfront.Distribution
  ): cloudfront.Distribution {
    distribution.applyRemovalPolicy(RemovalPolicy.RETAIN);
    return distribution;
  }

  // One origin object per bucket per distribution; behaviors that share it
  // share one origin entry in the distribution.
  private originFor(bucket: s3.IBucket): cloudfront.IOrigin {
    return origins.S3BucketOrigin.withOriginAccessControl(bucket);
  }

  private makeBehavior(
    origin: cloudfront.IOrigin,
    fn: cloudfront.IFunction,
    securityHeaders: boolean
  ): cloudfront.BehaviorOptions {
    return {
      origin,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      compress: true,
      responseHeadersPolicy: securityHeaders
        ? cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS
        : undefined,
      functionAssociations: [
        {
          function: fn,
          eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
        },
      ],
    };
  }

  private makeDataBehaviors(
    fn: cloudfront.IFunction,
    securityHeaders: boolean
  ): Record<string, cloudfront.BehaviorOptions> {
    const behaviors: Record<string, cloudfront.BehaviorOptions> = {};
    const dataOrigin = this.originFor(this.dataBucket);
    for (const pathPattern of DATA_PATHS) {
      behaviors[pathPattern] = this.makeBehavior(
        dataOrigin,
        fn,
        securityHeaders
      );
    }
    return behaviors;
  }

  private makeRecords(
    props: WebStackProps,
    hostnames: string[],
    distribution: cloudfront.IDistribution
  ): void {
    const target = route53.RecordTarget.fromAlias(
      new targets.CloudFrontTarget(distribution)
    );
    for (const hostname of hostnames) {
      const zone = hostname.endsWith(COM_DOMAIN)
        ? props.comZone
        : props.orgZone;
      // "*.landslidesncgs.org" becomes "wildcard-landslidesncgs-org".
      const id = hostname.replace('*', 'wildcard').replace(/\./g, '-');
      new route53.ARecord(this, `A-${id}`, {
        zone,
        recordName: hostname,
        target,
      });
      new route53.AaaaRecord(this, `AAAA-${id}`, {
        zone,
        recordName: hostname,
        target,
      });
    }
  }
}
