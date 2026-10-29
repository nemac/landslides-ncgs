import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MAX_FUNCTION_BYTES,
  composeDevFunction,
  composeFrom,
  composePreviewFunction,
  composeProductionFunction,
} from '../lib/compose-function.js';

const here = path.dirname(fileURLToPath(import.meta.url));

function eventFor(host: string, uri: string) {
  return {
    request: { uri, querystring: {}, headers: { host: { value: host } } },
  };
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

test('preview function awaits basicAuth, then rewrites, then prefixes', () => {
  const code = composePreviewFunction();
  assert.ok(code.startsWith("import cf from 'cloudfront';"));
  assert.equal(code.match(/async function handler\(/g)?.length, 1);
  assert.match(code, /await basicAuth\(event, kvs\)/);
  assert.match(code, /function rewrite\(/);
  assert.match(code, /return previewPrefix\(out\)/);
});

test('all three stay under the CloudFront limit', () => {
  for (const code of [
    composeProductionFunction(),
    composeDevFunction(),
    composePreviewFunction(),
  ]) {
    assert.ok(Buffer.byteLength(code, 'utf8') < MAX_FUNCTION_BYTES);
  }
});

test('production handler behaves end to end', () => {
  const handler = new Function(
    composeProductionFunction() + '\n; return handler;'
  )();
  assert.equal(
    handler(eventFor('inventory.landslidesncgs.org', '/')).statusCode,
    200
  );
  const dashboard = handler(
    eventFor('dashboard.landslidesncgs.org', '/data/status.json')
  );
  assert.equal(dashboard.uri, '/simple/data/status.json');
  const rewritten = handler(eventFor('landslidesncgs.org', '/simple/'));
  assert.equal(rewritten.uri, '/simple/index.html');
});

// The composed preview handler with a stand-in for the cloudfront module,
// whose key value store always holds `credential`.
function previewHandler(credential: string) {
  const code = composePreviewFunction().replace(
    "import cf from 'cloudfront';",
    ''
  );
  const cf = { kvs: () => ({ get: async () => credential }) };
  return new Function('cf', code + '\n; return handler;')(cf);
}

test('preview handler behaves end to end', async () => {
  const credential = Buffer.from('user:pass').toString('base64');
  const handler = previewHandler(credential);
  const host = 'update-name.landslidesncgs.org';
  const signedIn = (uri: string) => {
    const event = eventFor(host, uri);
    Object.assign(event.request.headers, {
      authorization: { value: 'Basic ' + credential },
    });
    return event;
  };

  assert.equal((await handler(eventFor(host, '/'))).statusCode, 401);
  const page = await handler(signedIn('/about/'));
  assert.equal(page.uri, '/update-name/about/index.html');
  const redirect = await handler(signedIn('/about'));
  assert.equal(redirect.statusCode, 301);
  assert.equal(redirect.headers.location.value, '/about/');
  const data = await handler(signedIn('/simple/data/status.json'));
  assert.equal(data.uri, '/simple/data/status.json');
});

test('oversized piece throws at compose time', () => {
  const fixtures = path.join(here, 'fixtures', 'oversized');
  assert.throws(() => composeFrom(fixtures, 'production'), /10240/);
});
