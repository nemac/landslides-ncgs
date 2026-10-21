import { test } from 'node:test';
import assert from 'node:assert/strict';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { DnsStack } from '../lib/dns-stack.js';
import { ACCOUNT, REGION } from '../lib/config.js';

const env = { account: ACCOUNT, region: REGION };

test('DnsStack has both zones and one cert covering apexes and wildcards', () => {
  const stack = new DnsStack(new App(), 'Dns', { env });
  const template = Template.fromStack(stack);
  template.resourceCountIs('AWS::Route53::HostedZone', 2);
  template.hasResourceProperties('AWS::Route53::HostedZone', { Name: 'landslidesncgs.org.' });
  template.hasResourceProperties('AWS::Route53::HostedZone', { Name: 'landslidesncgs.com.' });
  template.resourceCountIs('AWS::CertificateManager::Certificate', 1);
  template.hasResourceProperties('AWS::CertificateManager::Certificate', {
    DomainName: 'landslidesncgs.org',
    SubjectAlternativeNames: Match.arrayWith(['*.landslidesncgs.org', 'landslidesncgs.com', '*.landslidesncgs.com']),
    ValidationMethod: 'DNS',
  });
  assert.ok(stack.orgZone && stack.comZone && stack.certificate);
});
