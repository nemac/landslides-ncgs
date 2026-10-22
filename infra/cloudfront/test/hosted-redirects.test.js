const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadPiece, eventFor } = require('./load-piece.js');

const hostedRedirects = loadPiece('landslides-hosted-redirects.js', 'hostedRedirects');

const VIEWER_URL =
  'https://unca.maps.arcgis.com/apps/webappviewer/index.html?id=e9f79de934f24e40a71bab8db8050612';

test('inventory host returns the iframe page', () => {
  const out = hostedRedirects(eventFor('inventory.landslidesncgs.org', '/'));
  assert.equal(out.statusCode, 200);
  assert.equal(out.headers['content-type'].value, 'text/html; charset=utf-8');
  assert.equal(out.headers['cache-control'].value, 'public, max-age=300');
  assert.match(out.body, /experience\.arcgis\.com\/experience\/cd122ec3a6414d8e80ca93f5efe6bcb5/);
  assert.match(out.body, /<title>Landslide Inventory \| NC Geological Survey<\/title>/);
});

test('mapviewer.org redirects to the ArcGIS viewer', () => {
  const out = hostedRedirects(eventFor('mapviewer.landslidesncgs.org', '/anything'));
  assert.equal(out.statusCode, 301);
  assert.equal(out.headers.location.value, VIEWER_URL);
});

test('mapviewer.com redirects the same way', () => {
  const out = hostedRedirects(eventFor('mapviewer.landslidesncgs.com', '/'));
  assert.equal(out.statusCode, 301);
  assert.equal(out.headers.location.value, VIEWER_URL);
});

test('dashboard host redirects to DFENS Simple from any path', () => {
  for (const uri of ['/', '/index.html', '/data/forecast.geojson']) {
    const out = hostedRedirects(eventFor('dashboard.landslidesncgs.org', uri));
    assert.equal(out.statusCode, 301);
    assert.equal(out.headers.location.value, 'https://landslidesncgs.org/simple/');
  }
});

for (const host of [
  'landslidesncgs.org',
  'www.landslidesncgs.org',
  'landslidesncgs.com',
  'www.landslidesncgs.com',
]) {
  test(host + ' falls through', () => {
    assert.equal(hostedRedirects(eventFor(host, '/')), null);
  });
}

test('missing host header falls through', () => {
  assert.equal(hostedRedirects(eventFor(null, '/')), null);
});
