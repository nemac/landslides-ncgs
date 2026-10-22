const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadPiece, eventFor } = require('./load-piece.js');

const rewrite = loadPiece('landslides-rewrite.js', 'rewrite');

test('directory path without slash redirects 301 with query kept', () => {
  const out = rewrite(eventFor('landslidesncgs.org', '/simple', { querystring: { a: { value: '1' } } }));
  assert.equal(out.statusCode, 301);
  assert.equal(out.headers.location.value, '/simple/?a=1');
});

for (const uri of ['/alerts', '/alerts/', '/alerts/index.html', '/alerts/js/app.js', '/alerts/data']) {
  test('retired dashboard path ' + uri + ' redirects to /simple/', () => {
    const out = rewrite(eventFor('landslidesncgs.org', uri));
    assert.equal(out.statusCode, 301);
    assert.equal(out.headers.location.value, '/simple/');
  });
}

test('alerts data files still pass through', () => {
  const out = rewrite(eventFor('landslidesncgs.org', '/alerts/data/forecast.geojson'));
  assert.equal(out.uri, '/alerts/data/forecast.geojson');
});

test('a path that merely starts with alerts is not redirected', () => {
  const out = rewrite(eventFor('landslidesncgs.org', '/alertsmap/x.js'));
  assert.equal(out.uri, '/alertsmap/x.js');
});

test('trailing slash gets index.html', () => {
  const out = rewrite(eventFor('landslidesncgs.org', '/simple/'));
  assert.equal(out.uri, '/simple/index.html');
});

test('a file path passes through', () => {
  const out = rewrite(eventFor('landslidesncgs.org', '/simple/js/app.js'));
  assert.equal(out.uri, '/simple/js/app.js');
});
