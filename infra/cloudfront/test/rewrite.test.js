const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadPiece, eventFor } = require('./load-piece.js');

const rewrite = loadPiece('landslides-rewrite.js', 'rewrite');

test('directory path without slash redirects 301 with query kept', () => {
  const out = rewrite(eventFor('landslidesncgs.org', '/simple', { querystring: { a: { value: '1' } } }));
  assert.equal(out.statusCode, 301);
  assert.equal(out.headers.location.value, '/simple/?a=1');
});

test('dashboard host is prefixed with /alerts', () => {
  const out = rewrite(eventFor('dashboard.landslidesncgs.org', '/data/forecast.geojson'));
  assert.equal(out.uri, '/alerts/data/forecast.geojson');
});

test('trailing slash gets index.html', () => {
  const out = rewrite(eventFor('landslidesncgs.org', '/alerts/'));
  assert.equal(out.uri, '/alerts/index.html');
});

test('a file path passes through', () => {
  const out = rewrite(eventFor('landslidesncgs.org', '/alerts/js/app.js'));
  assert.equal(out.uri, '/alerts/js/app.js');
});
