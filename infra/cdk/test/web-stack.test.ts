import { test } from 'node:test';
import assert from 'node:assert/strict';
import { App } from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
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

// ---- The "page not found" page ---------------------------------------------
// A missing page should show /404/index.html with a 404. Two rules keep the
// data files out of it, because scripts/reference_check.py reads its state
// file through the site and treats a 403 and a 404 differently on purpose:
//   - only a 404 from the origin is replaced, never a 403;
//   - only the site buckets can answer 404. CloudFront may list those two
//     buckets, so a missing page there is a 404. It may not list the data
//     bucket, so a missing data file stays a 403.
const NOT_FOUND_RESPONSE = [
  {
    ErrorCode: 404,
    ResponseCode: 404,
    ResponsePagePath: '/404/index.html',
    ErrorCachingMinTTL: 60,
  },
];

test('production and dev show the 404 page for a missing page, and only for a 404', () => {
  const { template } = webTemplate();
  for (const config of [productionConfig(template), devConfig(template)]) {
    assert.deepEqual(config.CustomErrorResponses, NOT_FOUND_RESPONSE);
  }
});

test('previews have no 404 page: their files sit in a pr-<number>/ folder', () => {
  const config = previewConfig(webTemplate().template);
  assert.equal(config.CustomErrorResponses, undefined);
});

// Which buckets a bucket policy lets someone list, by the bucket's name in
// the template ("SiteBucket...", "DataBucket...").
function listableBuckets(template: Template): string[] {
  const policies = template.findResources('AWS::S3::BucketPolicy');
  const names: string[] = [];
  for (const policy of Object.values(policies)) {
    for (const statement of policy.Properties.PolicyDocument.Statement) {
      const actions = [statement.Action].flat();
      if (actions.includes('s3:ListBucket')) {
        names.push(policy.Properties.Bucket.Ref.replace(/[0-9A-F]{8}$/, ''));
      }
    }
  }
  return names.sort();
}

test('CloudFront may list the production and dev site buckets, and no other', () => {
  const { template } = webTemplate();
  assert.deepEqual(listableBuckets(template), ['DevSiteBucket', 'SiteBucket']);
});

// CDK warns about every listable origin. The stack answers that warning
// for production and dev only, so a listable origin added anywhere else
// (the previews, say) shows up here as a warning nobody answered.
test('no listable origin is left with its CDK warning unanswered', () => {
  const { web } = webTemplate();
  const warnings = Annotations.fromStack(web).findWarning(
    '*',
    Match.stringLikeRegexp('listBucketSecurityRisk')
  );
  assert.deepEqual(
    warnings.map((warning) => warning.id),
    []
  );
});

test('the listing permission is for CloudFront only', () => {
  const { template } = webTemplate();
  const policies = template.findResources('AWS::S3::BucketPolicy');
  for (const policy of Object.values(policies)) {
    for (const statement of policy.Properties.PolicyDocument.Statement) {
      if (![statement.Action].flat().includes('s3:ListBucket')) continue;
      assert.deepEqual(statement.Principal, {
        Service: 'cloudfront.amazonaws.com',
      });
      assert.ok(
        statement.Condition?.StringEquals?.['AWS:SourceArn'],
        'limited to one distribution'
      );
    }
  }
});

// With the listing permission, a request for the bucket root itself would
// return the list of files. The function already turns "/" into
// "/index.html"; the default root object is a second guard.
test('production and dev never ask the origin for the bucket root', () => {
  const { template } = webTemplate();
  for (const config of [productionConfig(template), devConfig(template)]) {
    assert.equal(config.DefaultRootObject, 'index.html');
  }
});
