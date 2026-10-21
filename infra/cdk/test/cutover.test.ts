import { test } from 'node:test';
import assert from 'node:assert/strict';
import { App } from 'aws-cdk-lib';
import { PROD_HOSTNAMES } from '../lib/config.js';
import { productionDomainNames, readCutoverStage, recordedHostnames } from '../lib/cutover.js';

const WILDCARDS = ['*.landslidesncgs.org', '*.landslidesncgs.com'];
const APEXES = ['landslidesncgs.org', 'landslidesncgs.com'];

test('wildcard stage has only the two wildcards and records nothing', () => {
  assert.deepEqual(productionDomainNames('wildcard'), WILDCARDS);
  assert.deepEqual(recordedHostnames('wildcard'), []);
});

test('subdomains stage has six exact names plus both wildcards', () => {
  const names = productionDomainNames('subdomains');
  assert.equal(names.length, 8);
  for (const apex of APEXES) assert.ok(!names.includes(apex), `${apex} must not be present`);
  for (const w of WILDCARDS) assert.ok(names.includes(w), `${w} must be present`);
  assert.equal(recordedHostnames('subdomains').length, 6);
});

test('done stage has the eight exact names and no wildcard', () => {
  assert.deepEqual(productionDomainNames('done'), [...PROD_HOSTNAMES]);
  assert.deepEqual(recordedHostnames('done'), [...PROD_HOSTNAMES]);
});

test('stage defaults to wildcard', () => {
  assert.equal(readCutoverStage(new App()), 'wildcard');
});

test('unknown stage throws', () => {
  const app = new App({ context: { cutover: 'nope' } });
  assert.throws(() => readCutoverStage(app), /cutover/);
});
