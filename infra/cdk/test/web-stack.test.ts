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
  return distributionConfigs(template).find((c) =>
    c.Aliases.includes('landslidesncgs.org')
  );
}

function devConfig(template: Template) {
  return distributionConfigs(template).find((c) =>
    c.Aliases.includes('dev.landslidesncgs.org')
  );
}

function previewConfig(template: Template) {
  return distributionConfigs(template).find((c) =>
    c.Aliases.includes('*.landslidesncgs.org')
  );
}

test('four private buckets, data versioned with old versions expiring', () => {
  const { template } = webTemplate();
  template.resourceCountIs('AWS::S3::Bucket', 4);
  template.hasResourceProperties('AWS::S3::Bucket', {
    BucketName: 'landslidesncgs-data',
    VersioningConfiguration: { Status: 'Enabled' },
    LifecycleConfiguration: {
      Rules: [
        Match.objectLike({
          Status: 'Enabled',
          NoncurrentVersionExpiration: { NoncurrentDays: 30 },
        }),
      ],
    },
  });
  for (const name of ['landslidesncgs-site', 'landslidesncgs-dev-site']) {
    const bucket = Object.values(
      template.findResources('AWS::S3::Bucket', {
        Properties: { BucketName: name },
      })
    )[0];
    assert.equal(bucket.Properties.LifecycleConfiguration, undefined);
  }
  for (const name of [
    'landslidesncgs-site',
    'landslidesncgs-data',
    'landslidesncgs-dev-site',
    'landslidesncgs-preview-site',
  ]) {
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketName: name,
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  }
});

test('preview bucket is unversioned and expires objects after 60 days', () => {
  const { template } = webTemplate();
  const bucket = Object.values(
    template.findResources('AWS::S3::Bucket', {
      Properties: { BucketName: 'landslidesncgs-preview-site' },
    })
  )[0];
  assert.equal(bucket.Properties.VersioningConfiguration, undefined);
  assert.deepEqual(bucket.Properties.LifecycleConfiguration.Rules, [
    { Id: 'expire-objects', Status: 'Enabled', ExpirationInDays: 60 },
  ]);
});

test('production distribution claims exactly the eight production hostnames', () => {
  const aliases = productionConfig(webTemplate().template)?.Aliases;
  assert.equal(aliases.length, 8);
  assert.deepEqual(aliases, [...PROD_HOSTNAMES]);
  for (const alias of aliases)
    assert.ok(!alias.startsWith('*'), alias + ' must not be a wildcard');
});

test('production has the three data behaviors, compression and one function each', () => {
  const config = productionConfig(webTemplate().template);
  const patterns = config.CacheBehaviors.map(
    (b: { PathPattern: string }) => b.PathPattern
  );
  assert.deepEqual(patterns, ['alerts/data/*', 'simple/data/*', 'data/*']);
  for (const behavior of [
    config.DefaultCacheBehavior,
    ...config.CacheBehaviors,
  ]) {
    assert.equal(behavior.Compress, true);
    assert.equal(behavior.ViewerProtocolPolicy, 'redirect-to-https');
    assert.equal(behavior.FunctionAssociations.length, 1);
    assert.equal(behavior.FunctionAssociations[0].EventType, 'viewer-request');
  }
  assert.equal(config.Origins.length, 2);
});

test('production attaches the managed security headers policy', () => {
  const config = productionConfig(webTemplate().template);
  assert.equal(
    config.DefaultCacheBehavior.ResponseHeadersPolicyId,
    '67f7725c-6f97-4210-82d7-5512b31e9d03'
  );
});

test('dev distribution has one alias and a key value store on its function', () => {
  const { template } = webTemplate();
  assert.deepEqual(devConfig(template)?.Aliases, ['dev.landslidesncgs.org']);
  template.resourceCountIs('AWS::CloudFront::KeyValueStore', 1);
  template.hasResourceProperties('AWS::CloudFront::KeyValueStore', {
    Name: 'landslides-dev-basic-auth',
  });
  template.hasResourceProperties('AWS::CloudFront::Function', {
    Name: 'landslides-dev',
    FunctionConfig: Match.objectLike({
      Runtime: 'cloudfront-js-2.0',
      KeyValueStoreAssociations: Match.anyValue(),
    }),
  });
  template.resourceCountIs('AWS::CloudFront::Function', 3);
});

test('preview distribution claims only the .org wildcard', () => {
  const { template } = webTemplate();
  assert.deepEqual(previewConfig(template)?.Aliases, ['*.landslidesncgs.org']);
  assert.equal(distributionConfigs(template).length, 3);
});

test('preview function shares the dev credential store', () => {
  const { template } = webTemplate();
  const functions = Object.values(
    template.findResources('AWS::CloudFront::Function')
  );
  const byName = (name: string) =>
    functions.find((f) => f.Properties.Name === name)?.Properties.FunctionConfig
      .KeyValueStoreAssociations;
  assert.ok(byName('landslides-preview'));
  assert.deepEqual(byName('landslides-preview'), byName('landslides-dev'));
});

test('preview reads its own bucket and the production data bucket', () => {
  const config = previewConfig(webTemplate().template);
  const patterns = config.CacheBehaviors.map(
    (b: { PathPattern: string }) => b.PathPattern
  );
  assert.deepEqual(patterns, ['alerts/data/*', 'simple/data/*', 'data/*']);
  const origins = JSON.stringify(config.Origins);
  assert.match(origins, /PreviewSiteBucket/);
  assert.match(origins, /DataBucket/);
  assert.equal(config.Origins.length, 2);
});

test('every production hostname, dev and the preview wildcard get A and AAAA records', () => {
  const sets = Object.values(
    webTemplate().template.findResources('AWS::Route53::RecordSet')
  ).map((r) => r.Properties);
  const names = (type: string) =>
    sets
      .filter((r) => r.Type === type)
      .map((r) => r.Name.replace(/\.$/, ''))
      .sort();
  const expected = [
    ...PROD_HOSTNAMES,
    'dev.landslidesncgs.org',
    '*.landslidesncgs.org',
  ].sort();
  assert.deepEqual(names('A'), expected);
  assert.deepEqual(names('AAAA'), expected);
});

test('exports the buckets and distributions', () => {
  const { web } = webTemplate();
  assert.ok(
    web.siteBucket &&
      web.dataBucket &&
      web.devSiteBucket &&
      web.previewSiteBucket
  );
  assert.ok(
    web.productionDistribution.distributionId &&
      web.devDistribution.distributionId &&
      web.previewDistribution.distributionId
  );
});

test('outputs what the runbook and workflows need', () => {
  const { template } = webTemplate();
  for (const name of [
    'ProductionDistributionId',
    'ProductionDomainName',
    'DevDistributionId',
    'DevDomainName',
    'PreviewDistributionId',
    'PreviewDomainName',
    'DevAuthStoreArn',
  ]) {
    template.hasOutput(name, Match.anyValue());
  }
});

test('distributions are retained and the stack is termination protected', () => {
  const { web, template } = webTemplate();
  assert.equal(web.terminationProtection, true);
  for (const d of Object.values(
    template.findResources('AWS::CloudFront::Distribution')
  )) {
    assert.equal(d.DeletionPolicy, 'Retain');
  }
});
