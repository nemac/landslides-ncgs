import { CfnOutput, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import type * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';
import { composeDevFunction, composeProductionFunction } from './compose-function.js';
import { COM_DOMAIN, DATA_BUCKET, DEV_HOSTNAME, DEV_SITE_BUCKET, SITE_BUCKET } from './config.js';
import { type CutoverStage, productionDomainNames, recordedHostnames } from './cutover.js';

export interface WebStackProps extends StackProps {
  stage: CutoverStage;
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

// Site, data and dev-site buckets with the production and dev distributions.
// All in one stack because the dev distribution reads the production data
// bucket, and an origin access control across stacks would cycle through the
// bucket policy. Hostname records live here too, next to what they point at.
export class WebStack extends Stack {
  readonly siteBucket: s3.IBucket;
  readonly dataBucket: s3.IBucket;
  readonly devSiteBucket: s3.IBucket;
  readonly productionDistribution: cloudfront.IDistribution;
  readonly devDistribution: cloudfront.IDistribution;
  private devAuthStore!: cloudfront.IKeyValueStore;

  constructor(scope: Construct, id: string, props: WebStackProps) {
    super(scope, id, { terminationProtection: true, ...props });
    this.siteBucket = this.makeBucket('SiteBucket', SITE_BUCKET, false);
    this.dataBucket = this.makeBucket('DataBucket', DATA_BUCKET, true);
    this.devSiteBucket = this.makeBucket('DevSiteBucket', DEV_SITE_BUCKET, false);

    this.productionDistribution = this.makeProductionDistribution(props);
    this.devDistribution = this.makeDevDistribution(props);

    this.makeRecords(props, recordedHostnames(props.stage), this.productionDistribution);
    this.makeRecords(props, [DEV_HOSTNAME], this.devDistribution);
    this.makeOutputs();
  }

  // Values the cutover runbook (infra/README.md) and the workflows copy.
  private makeOutputs(): void {
    new CfnOutput(this, 'ProductionDistributionId', { value: this.productionDistribution.distributionId });
    new CfnOutput(this, 'ProductionDomainName', { value: this.productionDistribution.distributionDomainName });
    new CfnOutput(this, 'DevDistributionId', { value: this.devDistribution.distributionId });
    new CfnOutput(this, 'DevDomainName', { value: this.devDistribution.distributionDomainName });
    new CfnOutput(this, 'DevAuthStoreArn', { value: this.devAuthStore.keyValueStoreArn });
  }

  private makeBucket(id: string, bucketName: string, versioned: boolean): s3.IBucket {
    return new s3.Bucket(this, id, {
      bucketName,
      versioned,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
  }

  private makeProductionDistribution(props: WebStackProps): cloudfront.IDistribution {
    const fn = new cloudfront.Function(this, 'ProductionFunction', {
      functionName: 'landslides-production',
      code: cloudfront.FunctionCode.fromInline(composeProductionFunction()),
      runtime: cloudfront.FunctionRuntime.JS_2_0,
    });
    return this.retained(new cloudfront.Distribution(this, 'ProductionDistribution', {
      comment: 'landslidesncgs.org production site, dashboard, DFENS Simple, inventory and mapviewer hosts',
      domainNames: productionDomainNames(props.stage),
      certificate: props.certificate,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      defaultBehavior: this.makeBehavior(this.originFor(this.siteBucket), fn, true),
      additionalBehaviors: this.makeDataBehaviors(fn, true),
    }));
  }

  private makeDevDistribution(props: WebStackProps): cloudfront.IDistribution {
    const store = new cloudfront.KeyValueStore(this, 'DevAuthStore', {
      keyValueStoreName: 'landslides-dev-basic-auth',
      comment: 'basic-auth: base64 of user:password for dev.landslidesncgs.org (set by hand)',
    });
    this.devAuthStore = store;
    const fn = new cloudfront.Function(this, 'DevFunction', {
      functionName: 'landslides-dev',
      code: cloudfront.FunctionCode.fromInline(composeDevFunction()),
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      keyValueStore: store,
    });
    return this.retained(new cloudfront.Distribution(this, 'DevDistribution', {
      comment: 'dev.landslidesncgs.org, basic auth, reads production data',
      domainNames: [DEV_HOSTNAME],
      certificate: props.certificate,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      defaultBehavior: this.makeBehavior(this.originFor(this.devSiteBucket), fn, false),
      additionalBehaviors: this.makeDataBehaviors(fn, false),
    }));
  }

  // A distribution that CloudFormation drops is a live hostname gone; keep it.
  private retained(distribution: cloudfront.Distribution): cloudfront.Distribution {
    distribution.applyRemovalPolicy(RemovalPolicy.RETAIN);
    return distribution;
  }

  // One origin object per bucket per distribution; behaviors that share it
  // share one origin entry in the distribution.
  private originFor(bucket: s3.IBucket): cloudfront.IOrigin {
    return origins.S3BucketOrigin.withOriginAccessControl(bucket);
  }

  private makeBehavior(origin: cloudfront.IOrigin, fn: cloudfront.IFunction, securityHeaders: boolean): cloudfront.BehaviorOptions {
    return {
      origin,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      compress: true,
      responseHeadersPolicy: securityHeaders ? cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS : undefined,
      functionAssociations: [{ function: fn, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST }],
    };
  }

  private makeDataBehaviors(fn: cloudfront.IFunction, securityHeaders: boolean): Record<string, cloudfront.BehaviorOptions> {
    const behaviors: Record<string, cloudfront.BehaviorOptions> = {};
    const dataOrigin = this.originFor(this.dataBucket);
    for (const pathPattern of DATA_PATHS) {
      behaviors[pathPattern] = this.makeBehavior(dataOrigin, fn, securityHeaders);
    }
    return behaviors;
  }

  private makeRecords(props: WebStackProps, hostnames: string[], distribution: cloudfront.IDistribution): void {
    const target = route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution));
    for (const hostname of hostnames) {
      const zone = hostname.endsWith(COM_DOMAIN) ? props.comZone : props.orgZone;
      const id = hostname.replace(/\./g, '-');
      new route53.ARecord(this, `A-${id}`, { zone, recordName: hostname, target });
      new route53.AaaaRecord(this, `AAAA-${id}`, { zone, recordName: hostname, target });
    }
  }
}
