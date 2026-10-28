const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { previewSlug } = require('../preview-slug.js');

const SCRIPT = path.join(__dirname, '..', 'preview-slug.js');

test('a plain branch name is used as is', () => {
  assert.equal(previewSlug('update-name', 7), 'update-name');
});

test('slashes, underscores and capitals become one lower-case label', () => {
  assert.equal(previewSlug('feature/Update_Name', 7), 'feature-update-name');
  assert.equal(previewSlug('fix//two..dots', 7), 'fix-two-dots');
});

test('hyphens at either end are trimmed', () => {
  assert.equal(previewSlug('-wip-', 7), 'wip');
  assert.equal(previewSlug('/leading/slash/', 7), 'leading-slash');
});

test('a long branch is cut to 63 characters without a trailing hyphen', () => {
  const slug = previewSlug('a'.repeat(62) + '-bbbb', 7);
  assert.equal(slug, 'a'.repeat(62));
  assert.ok(previewSlug('x'.repeat(100), 7).length === 63);
});

test('a branch with nothing usable falls back to pr-<number>', () => {
  assert.equal(previewSlug('___', 12), 'pr-12');
  assert.equal(previewSlug('ünïcode', 12), 'n-code');
  assert.equal(previewSlug('日本', 12), 'pr-12');
});

test('a branch that lands on a real hostname falls back to pr-<number>', () => {
  for (const branch of ['dev', 'WWW', 'dashboard', 'inventory', 'mapviewer']) {
    assert.equal(previewSlug(branch, 3), 'pr-3', branch);
  }
  assert.equal(previewSlug('dev-tweaks', 3), 'dev-tweaks');
});

test('the command line prints the slug', () => {
  const out = execFileSync('node', [SCRIPT, 'feature/Update_Name', '7'], {
    encoding: 'utf8',
  });
  assert.equal(out, 'feature-update-name\n');
});

test('the command line refuses a missing or non-numeric PR number', () => {
  assert.throws(() =>
    execFileSync('node', [SCRIPT, 'update-name'], { stdio: 'ignore' })
  );
  assert.throws(() =>
    execFileSync('node', [SCRIPT, 'update-name', '7; rm'], { stdio: 'ignore' })
  );
});
