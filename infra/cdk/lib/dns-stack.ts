import { RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
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
    super(scope, id, { terminationProtection: true, ...props });
    this.orgZone = this.makeZone('OrgZone', ORG_DOMAIN);
    this.comZone = this.makeZone('ComZone', COM_DOMAIN);
    this.certificate = this.makeCertificate();
  }

  // Once the registrar points at these zones they are the only DNS for the
  // domain; a replaced zone gets new name servers and takes the site down.
  private makeZone(id: string, zoneName: string): route53.IHostedZone {
    const zone = new route53.PublicHostedZone(this, id, { zoneName });
    zone.applyRemovalPolicy(RemovalPolicy.RETAIN);
    return zone;
  }

  private makeCertificate(): acm.ICertificate {
    return new acm.Certificate(this, 'Certificate', {
      domainName: ORG_DOMAIN,
      subjectAlternativeNames: [
        `*.${ORG_DOMAIN}`,
        COM_DOMAIN,
        `*.${COM_DOMAIN}`,
      ],
      validation: acm.CertificateValidation.fromDnsMultiZone({
        [ORG_DOMAIN]: this.orgZone,
        [`*.${ORG_DOMAIN}`]: this.orgZone,
        [COM_DOMAIN]: this.comZone,
        [`*.${COM_DOMAIN}`]: this.comZone,
      }),
    });
  }
}
