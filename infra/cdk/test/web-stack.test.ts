import { test } from 'node:test';
import assert from 'node:assert/strict';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { ACCOUNT, PROD_HOSTNAMES, REGION } from '../lib/config.js';
import { DnsStack } from '../lib/dns-stack.js';
import { WebStack } from '../lib/web-stack.js';

const env = { account: ACCOUNT, region: REGION };

function webTemplate() {
  const app = new App();
  const dns = new DnsStack(app, 'Dns', { env });
  const web = new WebStack(app, 'Web', {
    env,
    orgZone: dns.orgZone,
    comZone: dns.comZone,
    certificate: dns.certificate,
  });
  return { web, template: Template.fromStack(web) };
}

function distributionConfigs(template: Template) {
  const all = template.findResources('AWS::CloudFront::Distribution');
  return Object.values(all).map((r) => r.Properties.DistributionConfig);
}

function productionConfig(template: Template) {
  return distributionConfigs(template).find((c) => !c.Aliases.includes('dev.landslidesncgs.org'));
}

function devConfig(template: Template) {
  return distributionConfigs(template).find((c) => c.Aliases.includes('dev.landslidesncgs.org'));
}

test('three private buckets, data versioned', () => {
  const { template } = webTemplate();
  template.resourceCountIs('AWS::S3::Bucket', 3);
  template.hasResourceProperties('AWS::S3::Bucket', {
    BucketName: 'landslidesncgs-data',
    VersioningConfiguration: { Status: 'Enabled' },
  });
  for (const name of ['landslidesncgs-site', 'landslidesncgs-data', 'landslidesncgs-dev-site']) {
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketName: name,
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true,
      },
    });
  }
});

test('production distribution claims exactly the eight production hostnames', () => {
  const aliases = productionConfig(webTemplate().template)?.Aliases;
  assert.equal(aliases.length, 8);
  assert.deepEqual(aliases, [...PROD_HOSTNAMES]);
  for (const alias of aliases) assert.ok(!alias.startsWith('*'), alias + ' must not be a wildcard');
});

test('production has the three data behaviors, compression and one function each', () => {
  const config = productionConfig(webTemplate().template);
  const patterns = config.CacheBehaviors.map((b: { PathPattern: string }) => b.PathPattern);
  assert.deepEqual(patterns, ['alerts/data/*', 'simple/data/*', 'data/*']);
  for (const behavior of [config.DefaultCacheBehavior, ...config.CacheBehaviors]) {
    assert.equal(behavior.Compress, true);
    assert.equal(behavior.ViewerProtocolPolicy, 'redirect-to-https');
    assert.equal(behavior.FunctionAssociations.length, 1);
    assert.equal(behavior.FunctionAssociations[0].EventType, 'viewer-request');
  }
  assert.equal(config.Origins.length, 2);
});

test('production attaches the managed security headers policy', () => {
  const config = productionConfig(webTemplate().template);
  assert.equal(config.DefaultCacheBehavior.ResponseHeadersPolicyId, '67f7725c-6f97-4210-82d7-5512b31e9d03');
});

test('dev distribution has one alias and a key value store on its function', () => {
  const { template } = webTemplate();
  assert.deepEqual(devConfig(template)?.Aliases, ['dev.landslidesncgs.org']);
  template.resourceCountIs('AWS::CloudFront::KeyValueStore', 1);
  template.hasResourceProperties('AWS::CloudFront::KeyValueStore', { Name: 'landslides-dev-basic-auth' });
  template.hasResourceProperties('AWS::CloudFront::Function', {
    FunctionConfig: Match.objectLike({ Runtime: 'cloudfront-js-2.0', KeyValueStoreAssociations: Match.anyValue() }),
  });
  template.resourceCountIs('AWS::CloudFront::Function', 2);
});

test('every production hostname and the dev hostname get A and AAAA records', () => {
  const sets = Object.values(webTemplate().template.findResources('AWS::Route53::RecordSet')).map((r) => r.Properties);
  const names = (type: string) => sets.filter((r) => r.Type === type).map((r) => r.Name.replace(/\.$/, '')).sort();
  const expected = [...PROD_HOSTNAMES, 'dev.landslidesncgs.org'].sort();
  assert.deepEqual(names('A'), expected);
  assert.deepEqual(names('AAAA'), expected);
});

test('exports the buckets and distributions', () => {
  const { web } = webTemplate();
  assert.ok(web.siteBucket && web.dataBucket && web.devSiteBucket);
  assert.ok(web.productionDistribution.distributionId && web.devDistribution.distributionId);
});

test('outputs what the runbook and workflows need', () => {
  const { template } = webTemplate();
  for (const name of ['ProductionDistributionId', 'ProductionDomainName', 'DevDistributionId', 'DevDomainName', 'DevAuthStoreArn']) {
    template.hasOutput(name, Match.anyValue());
  }
});

test('distributions are retained and the stack is termination protected', () => {
  const { web, template } = webTemplate();
  assert.equal(web.terminationProtection, true);
  for (const d of Object.values(template.findResources('AWS::CloudFront::Distribution'))) {
    assert.equal(d.DeletionPolicy, 'Retain');
  }
});
