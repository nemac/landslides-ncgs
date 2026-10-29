import { CfnOutput, Stack, type StackProps } from 'aws-cdk-lib';
import type * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';
import {
  ACCOUNT,
  BUILDINGS_PREFIX,
  DEV_ROLE_NAME,
  GITHUB_REPO,
  PREVIEW_ROLE_NAME,
  PROD_ROLE_NAME,
} from './config.js';

export interface CiStackProps extends StackProps {
  siteBucket: s3.IBucket;
  dataBucket: s3.IBucket;
  devSiteBucket: s3.IBucket;
  previewSiteBucket: s3.IBucket;
  productionDistribution: cloudfront.IDistribution;
  devDistribution: cloudfront.IDistribution;
  previewDistribution: cloudfront.IDistribution;
}

const GITHUB_OIDC_URL = 'https://token.actions.githubusercontent.com';
const GITHUB_OIDC_HOST = 'token.actions.githubusercontent.com';

// GitHub Actions assume these roles with OIDC; no long-lived keys exist.
// Each role is trusted only by one GitHub environment of this repo and may
// touch only the buckets and distribution that environment deploys.
export class CiStack extends Stack {
  readonly prodRole: iam.IRole;
  readonly devRole: iam.IRole;
  readonly previewRole: iam.IRole;

  constructor(scope: Construct, id: string, props: CiStackProps) {
    super(scope, id, { terminationProtection: true, ...props });
    const provider = new iam.OpenIdConnectProvider(this, 'GitHub', {
      url: GITHUB_OIDC_URL,
      clientIds: ['sts.amazonaws.com'],
    });

    this.prodRole = this.makeRole(
      provider,
      'ProdRole',
      PROD_ROLE_NAME,
      'production'
    );
    props.siteBucket.grantReadWrite(this.prodRole);
    // The refresh workflows read and write data objects. The only deletes
    // are under the buildings prefix, which refresh-reference.yml mirrors
    // from a fresh extraction; the bucket is versioned, so even those are
    // recoverable for DATA_NONCURRENT_VERSION_DAYS.
    props.dataBucket.grantRead(this.prodRole);
    props.dataBucket.grantPut(this.prodRole);
    this.prodRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['s3:DeleteObject'],
        resources: [props.dataBucket.arnForObjects(`${BUILDINGS_PREFIX}*`)],
      })
    );
    this.allowInvalidation(this.prodRole, props.productionDistribution);

    this.devRole = this.makeRole(
      provider,
      'DevRole',
      DEV_ROLE_NAME,
      'development'
    );
    props.devSiteBucket.grantReadWrite(this.devRole);
    this.allowInvalidation(this.devRole, props.devDistribution);

    // pr-preview.yml runs for pull requests from any branch of this repo, so
    // this role reaches nothing but the preview bucket and distribution.
    this.previewRole = this.makeRole(
      provider,
      'PreviewRole',
      PREVIEW_ROLE_NAME,
      'preview'
    );
    props.previewSiteBucket.grantReadWrite(this.previewRole);
    this.allowInvalidation(this.previewRole, props.previewDistribution);

    new CfnOutput(this, 'ProdRoleArn', { value: this.prodRole.roleArn });
    new CfnOutput(this, 'DevRoleArn', { value: this.devRole.roleArn });
    new CfnOutput(this, 'PreviewRoleArn', {
      value: this.previewRole.roleArn,
    });
  }

  private makeRole(
    provider: iam.IOpenIdConnectProvider,
    id: string,
    roleName: string,
    environment: string
  ): iam.Role {
    return new iam.Role(this, id, {
      roleName,
      description: `GitHub Actions deploys from the ${environment} environment of ${GITHUB_REPO}`,
      assumedBy: new iam.WebIdentityPrincipal(
        provider.openIdConnectProviderArn,
        {
          StringEquals: {
            [`${GITHUB_OIDC_HOST}:aud`]: 'sts.amazonaws.com',
            [`${GITHUB_OIDC_HOST}:sub`]: `repo:${GITHUB_REPO}:environment:${environment}`,
          },
        }
      ),
    });
  }

  private allowInvalidation(
    role: iam.IRole,
    distribution: cloudfront.IDistribution
  ): void {
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['cloudfront:CreateInvalidation'],
        resources: [
          `arn:aws:cloudfront::${ACCOUNT}:distribution/${distribution.distributionId}`,
        ],
      })
    );
  }
}
