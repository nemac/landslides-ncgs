const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadPiece, eventFor } = require('./load-piece.js');

const previewPrefix = loadPiece(
  'landslides-preview-prefix.js',
  'previewPrefix'
);

function requestFor(host, uri) {
  return eventFor(host, uri).request;
}

test('a page is read from the folder named by the first label', () => {
  const out = previewPrefix(
    requestFor('update-name.landslidesncgs.org', '/about/index.html')
  );
  assert.equal(out.uri, '/update-name/about/index.html');
});

test('the root and assets are prefixed too', () => {
  const host = 'update-name.landslidesncgs.org';
  assert.equal(
    previewPrefix(requestFor(host, '/index.html')).uri,
    '/update-name/index.html'
  );
  assert.equal(
    previewPrefix(requestFor(host, '/assets/images/logo.png')).uri,
    '/update-name/assets/images/logo.png'
  );
});

test('an upper-case host maps to the same folder', () => {
  const out = previewPrefix(
    requestFor('Update-Name.LandslidesNCGS.org', '/index.html')
  );
  assert.equal(out.uri, '/update-name/index.html');
});

test('shared data paths are left alone', () => {
  const host = 'update-name.landslidesncgs.org';
  for (const uri of [
    '/alerts/data/buildings/buncombe.json',
    '/simple/data/status.json',
  ]) {
    assert.equal(previewPrefix(requestFor(host, uri)).uri, uri);
  }
});

test('a host outside the domain or deeper than one label answers 404', () => {
  for (const host of [
    'landslidesncgs.org',
    'a.b.landslidesncgs.org',
    'update-name.landslidesncgs.com',
    'evil.example.org',
    '',
  ]) {
    const out = previewPrefix(requestFor(host, '/index.html'));
    assert.equal(out.statusCode, 404, `host "${host}"`);
  }
});

test('a label longer than DNS allows answers 404', () => {
  const host = 'a'.repeat(64) + '.landslidesncgs.org';
  assert.equal(previewPrefix(requestFor(host, '/')).statusCode, 404);
});
