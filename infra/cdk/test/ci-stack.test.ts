import { test } from 'node:test';
import assert from 'node:assert/strict';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { ACCOUNT, REGION } from '../lib/config.js';
import { CiStack } from '../lib/ci-stack.js';
import { DnsStack } from '../lib/dns-stack.js';
import { WebStack } from '../lib/web-stack.js';

const env = { account: ACCOUNT, region: REGION };

function ciTemplate() {
  const app = new App();
  const dns = new DnsStack(app, 'Dns', { env });
  const web = new WebStack(app, 'Web', { env, stage: 'done', orgZone: dns.orgZone, comZone: dns.comZone, certificate: dns.certificate });
  const ci = new CiStack(app, 'Ci', {
    env,
    siteBucket: web.siteBucket,
    dataBucket: web.dataBucket,
    devSiteBucket: web.devSiteBucket,
    productionDistribution: web.productionDistribution,
    devDistribution: web.devDistribution,
  });
  return { ci, template: Template.fromStack(ci) };
}

function trustSubject(template: Template, roleName: string): string {
  const roles = template.findResources('AWS::IAM::Role', { Properties: { RoleName: roleName } });
  const [role] = Object.values(roles);
  const statement = role.Properties.AssumeRolePolicyDocument.Statement[0];
  assert.equal(statement.Condition.StringEquals['token.actions.githubusercontent.com:aud'], 'sts.amazonaws.com');
  return statement.Condition.StringEquals['token.actions.githubusercontent.com:sub'];
}

function policyStatementsFor(template: Template, roleName: string): Array<Record<string, unknown>> {
  const policies = template.findResources('AWS::IAM::Policy');
  const statements: Array<Record<string, unknown>> = [];
  for (const policy of Object.values(policies)) {
    const attached = JSON.stringify(policy.Properties.Roles);
    if (!attached.includes(roleName.replace(/-/g, ''))) continue;
    statements.push(...policy.Properties.PolicyDocument.Statement);
  }
  return statements;
}

test('one GitHub OIDC provider', () => {
  const { template } = ciTemplate();
  template.resourceCountIs('Custom::AWSCDKOpenIdConnectProvider', 1);
  template.hasResourceProperties('Custom::AWSCDKOpenIdConnectProvider', {
    Url: 'https://token.actions.githubusercontent.com',
    ClientIDList: ['sts.amazonaws.com'],
  });
});

test('prod role trusts the production environment only', () => {
  assert.equal(trustSubject(ciTemplate().template, 'landslides-github-prod'), 'repo:nemac/landslides-ncgs:environment:production');
});

test('dev role trusts the development environment only', () => {
  assert.equal(trustSubject(ciTemplate().template, 'landslides-github-dev'), 'repo:nemac/landslides-ncgs:environment:development');
});

test('dev role has no statement on the data bucket', () => {
  const { template } = ciTemplate();
  const devStatements = JSON.stringify(policyStatementsFor(template, 'DevRole'));
  assert.doesNotMatch(devStatements, /DataBucket/);
  assert.match(devStatements, /DevSiteBucket/);
  const prodStatements = JSON.stringify(policyStatementsFor(template, 'ProdRole'));
  assert.match(prodStatements, /DataBucket/);
  assert.match(prodStatements, /SiteBucket/);
});

test('each role may invalidate only its distribution', () => {
  const { template } = ciTemplate();
  for (const [role, pattern] of [['ProdRole', /cloudfront::710482330128:distribution\//], ['DevRole', /cloudfront::710482330128:distribution\//]] as const) {
    const invalidations = policyStatementsFor(template, role).filter((s) => JSON.stringify(s).includes('cloudfront:CreateInvalidation'));
    assert.equal(invalidations.length, 1, `${role} has one invalidation statement`);
    assert.match(JSON.stringify(invalidations[0]), pattern);
  }
});

test('outputs both role ARNs', () => {
  const { template } = ciTemplate();
  template.hasOutput('ProdRoleArn', Match.anyValue());
  template.hasOutput('DevRoleArn', Match.anyValue());
});

test('stack is termination protected', () => {
  assert.equal(ciTemplate().ci.terminationProtection, true);
});
