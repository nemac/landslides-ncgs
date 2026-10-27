const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadPiece, eventFor } = require('./load-piece.js');

const basicAuth = loadPiece('landslides-basic-auth.js', 'basicAuth');

// Test-only credential; the real one lives in the KeyValueStore.
const GOOD = Buffer.from('user:pass').toString('base64');

function kvsWith(value) {
  return {
    get: async (key) => {
      if (key === 'basic-auth' && value !== undefined) return value;
      throw new Error('missing key');
    },
  };
}

function withAuth(headerValue) {
  const extra = headerValue
    ? {
        headers: {
          host: { value: 'dev.landslidesncgs.org' },
          authorization: { value: headerValue },
        },
      }
    : undefined;
  return eventFor('dev.landslidesncgs.org', '/', extra);
}

function assertChallenge(out) {
  assert.equal(out.statusCode, 401);
  assert.equal(
    out.headers['www-authenticate'].value,
    'Basic realm="landslides dev"'
  );
}

test('matching credential falls through', async () => {
  assert.equal(await basicAuth(withAuth('Basic ' + GOOD), kvsWith(GOOD)), null);
});

test('wrong credential gets 401 with challenge', async () => {
  const wrong = Buffer.from('user:nope').toString('base64');
  assertChallenge(await basicAuth(withAuth('Basic ' + wrong), kvsWith(GOOD)));
});

test('missing header gets 401', async () => {
  assertChallenge(await basicAuth(withAuth(null), kvsWith(GOOD)));
});

test('malformed header gets 401', async () => {
  assertChallenge(await basicAuth(withAuth('Bearer xyz'), kvsWith(GOOD)));
});

test('missing kvs key gets 401, not a throw', async () => {
  assertChallenge(
    await basicAuth(withAuth('Basic ' + GOOD), kvsWith(undefined))
  );
});
