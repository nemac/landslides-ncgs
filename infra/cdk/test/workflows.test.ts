import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ACCOUNT,
  DATA_BUCKET,
  DEV_ROLE_NAME,
  DEV_SITE_BUCKET,
  PROD_ROLE_NAME,
  SITE_BUCKET,
} from '../lib/config.js';

// The GitHub workflows carry role ARNs, bucket names and distribution ids as
// literals copied from the CDK outputs. Nothing at deploy time checks them,
// so this does: every literal must match config.ts, and each deploy
// workflow must use its own environment's role.
const here = path.dirname(fileURLToPath(import.meta.url));
const WORKFLOW_DIR = path.resolve(
  here,
  '..',
  '..',
  '..',
  '.github',
  'workflows'
);

function workflows(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const file of fs.readdirSync(WORKFLOW_DIR)) {
    if (file.endsWith('.yml')) {
      out[file] = fs.readFileSync(path.join(WORKFLOW_DIR, file), 'utf8');
    }
  }
  return out;
}

const prodArn = `arn:aws:iam::${ACCOUNT}:role/${PROD_ROLE_NAME}`;
const devArn = `arn:aws:iam::${ACCOUNT}:role/${DEV_ROLE_NAME}`;

test('every role ARN in the workflows is one the Ci stack creates', () => {
  const all = workflows();
  const seen: string[] = [];
  for (const [file, text] of Object.entries(all)) {
    for (const arn of text.match(/arn:aws:iam::[^\s"']+/g) ?? []) {
      seen.push(arn);
      assert.ok(
        [prodArn, devArn].includes(arn),
        `${file} uses unknown role ${arn}`
      );
    }
  }
  assert.ok(seen.length >= 4, 'at least four workflows name a role');
});

test('deploy workflows use the role of their own environment', () => {
  const all = workflows();
  assert.match(all['deploy-prod.yml'], new RegExp(`role_arn: ${prodArn}`));
  assert.match(all['deploy-prod.yml'], /environment: production/);
  assert.match(all['deploy-dev.yml'], new RegExp(`role_arn: ${devArn}`));
  assert.match(all['deploy-dev.yml'], /environment: development/);
  assert.doesNotMatch(all['deploy-dev.yml'], new RegExp(PROD_ROLE_NAME));
});

test('refresh workflows use the production role and the data bucket', () => {
  const all = workflows();
  for (const file of [
    'refresh-simple.yml',
    'refresh-reference.yml',
    'refresh-data.yml',
  ]) {
    assert.match(all[file], new RegExp(prodArn), `${file} role`);
    assert.match(all[file], new RegExp(DATA_BUCKET), `${file} bucket`);
    assert.doesNotMatch(
      all[file],
      new RegExp(DEV_ROLE_NAME),
      `${file} must not use the dev role`
    );
  }
});

test('deploy workflows name the right buckets and a plausible distribution id', () => {
  const all = workflows();
  assert.match(all['deploy-prod.yml'], new RegExp(`bucket: ${SITE_BUCKET}\\b`));
  assert.match(
    all['deploy-dev.yml'],
    new RegExp(`bucket: ${DEV_SITE_BUCKET}\\b`)
  );
  for (const file of ['deploy-prod.yml', 'deploy-dev.yml']) {
    assert.match(
      all[file],
      /distribution_id: E[A-Z0-9]{12,13}\n/,
      `${file} distribution id`
    );
  }
});
