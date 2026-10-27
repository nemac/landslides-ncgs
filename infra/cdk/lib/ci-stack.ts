import { CfnOutput, Stack, type StackProps } from 'aws-cdk-lib';
import type * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';
import { ACCOUNT, GITHUB_REPO } from './config.js';

export interface CiStackProps extends StackProps {
  siteBucket: s3.IBucket;
  dataBucket: s3.IBucket;
  devSiteBucket: s3.IBucket;
  productionDistribution: cloudfront.IDistribution;
  devDistribution: cloudfront.IDistribution;
}

const GITHUB_OIDC_URL = 'https://token.actions.githubusercontent.com';
const GITHUB_OIDC_HOST = 'token.actions.githubusercontent.com';

// GitHub Actions assume these roles with OIDC; no long-lived keys exist.
// Each role is trusted only by one GitHub environment of this repo and may
// touch only the buckets and distribution that environment deploys.
export class CiStack extends Stack {
  readonly prodRole: iam.IRole;
  readonly devRole: iam.IRole;

  constructor(scope: Construct, id: string, props: CiStackProps) {
    super(scope, id, { terminationProtection: true, ...props });
    const provider = new iam.OpenIdConnectProvider(this, 'GitHub', {
      url: GITHUB_OIDC_URL,
      clientIds: ['sts.amazonaws.com'],
    });

    this.prodRole = this.makeRole(
      provider,
      'ProdRole',
      'landslides-github-prod',
      'production'
    );
    props.siteBucket.grantReadWrite(this.prodRole);
    // The refresh workflows only read and write data objects; nothing deletes.
    props.dataBucket.grantRead(this.prodRole);
    props.dataBucket.grantPut(this.prodRole);
    this.allowInvalidation(this.prodRole, props.productionDistribution);

    this.devRole = this.makeRole(
      provider,
      'DevRole',
      'landslides-github-dev',
      'development'
    );
    props.devSiteBucket.grantReadWrite(this.devRole);
    this.allowInvalidation(this.devRole, props.devDistribution);

    new CfnOutput(this, 'ProdRoleArn', { value: this.prodRole.roleArn });
    new CfnOutput(this, 'DevRoleArn', { value: this.devRole.roleArn });
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
