import { Stack, type StackProps } from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import type { Construct } from 'constructs';
import { COM_DOMAIN, ORG_DOMAIN } from './config.js';

// Hosted zones for both domains and the one certificate every distribution
// uses. Hostname records live in WebStack, next to the distributions they
// point at; this stack deploys first and knows nothing about them.
export class DnsStack extends Stack {
  readonly orgZone: route53.IHostedZone;
  readonly comZone: route53.IHostedZone;
  readonly certificate: acm.ICertificate;

  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);
    this.orgZone = new route53.PublicHostedZone(this, 'OrgZone', { zoneName: ORG_DOMAIN });
    this.comZone = new route53.PublicHostedZone(this, 'ComZone', { zoneName: COM_DOMAIN });
    this.certificate = this.makeCertificate();
  }

  private makeCertificate(): acm.ICertificate {
    return new acm.Certificate(this, 'Certificate', {
      domainName: ORG_DOMAIN,
      subjectAlternativeNames: [`*.${ORG_DOMAIN}`, COM_DOMAIN, `*.${COM_DOMAIN}`],
      validation: acm.CertificateValidation.fromDnsMultiZone({
        [ORG_DOMAIN]: this.orgZone,
        [`*.${ORG_DOMAIN}`]: this.orgZone,
        [COM_DOMAIN]: this.comZone,
        [`*.${COM_DOMAIN}`]: this.comZone,
      }),
    });
  }
}
