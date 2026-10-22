import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MAX_FUNCTION_BYTES,
  composeDevFunction,
  composeFrom,
  composeProductionFunction,
} from '../lib/compose-function.js';

const here = path.dirname(fileURLToPath(import.meta.url));

function eventFor(host: string, uri: string) {
  return { request: { uri, querystring: {}, headers: { host: { value: host } } } };
}

test('production function defines one handler and both pieces', () => {
  const code = composeProductionFunction();
  assert.equal(code.match(/function handler\(/g)?.length, 1);
  assert.match(code, /function hostedRedirects\(/);
  assert.match(code, /function rewrite\(/);
  assert.doesNotMatch(code, /import cf/);
});

test('dev function imports cloudfront and awaits basicAuth', () => {
  const code = composeDevFunction();
  assert.ok(code.startsWith("import cf from 'cloudfront';"));
  assert.equal(code.match(/async function handler\(/g)?.length, 1);
  assert.match(code, /var kvs = cf\.kvs\(\);/);
  assert.match(code, /await basicAuth\(event, kvs\)/);
  assert.match(code, /function rewrite\(/);
});

test('both stay under the CloudFront limit', () => {
  assert.ok(Buffer.byteLength(composeProductionFunction(), 'utf8') < MAX_FUNCTION_BYTES);
  assert.ok(Buffer.byteLength(composeDevFunction(), 'utf8') < MAX_FUNCTION_BYTES);
});

test('production handler behaves end to end', () => {
  const handler = new Function(composeProductionFunction() + '\n; return handler;')();
  assert.equal(handler(eventFor('inventory.landslidesncgs.org', '/')).statusCode, 200);
  const dashboard = handler(eventFor('dashboard.landslidesncgs.org', '/data/status.json'));
  assert.equal(dashboard.uri, '/simple/data/status.json');
  const rewritten = handler(eventFor('landslidesncgs.org', '/simple/'));
  assert.equal(rewritten.uri, '/simple/index.html');
});

test('oversized piece throws at compose time', () => {
  const fixtures = path.join(here, 'fixtures', 'oversized');
  assert.throws(() => composeFrom(fixtures, 'production'), /10240/);
});
