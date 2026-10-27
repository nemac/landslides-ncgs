const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadPiece, eventFor } = require('./load-piece.js');

const rewrite = loadPiece('landslides-rewrite.js', 'rewrite');

test('directory path without slash redirects 301 with query kept', () => {
  const out = rewrite(
    eventFor('landslidesncgs.org', '/simple', {
      querystring: { a: { value: '1' } },
    })
  );
  assert.equal(out.statusCode, 301);
  assert.equal(out.headers.location.value, '/simple/?a=1');
});

for (const uri of [
  '/alerts',
  '/alerts/',
  '/alerts/index.html',
  '/alerts/js/app.js',
  '/alerts/data',
]) {
  test('retired dashboard path ' + uri + ' redirects to /simple/', () => {
    const out = rewrite(eventFor('landslidesncgs.org', uri));
    assert.equal(out.statusCode, 301);
    assert.equal(out.headers.location.value, '/simple/');
  });
}

test('alerts data files still pass through', () => {
  const out = rewrite(
    eventFor('landslidesncgs.org', '/alerts/data/forecast.geojson')
  );
  assert.equal(out.uri, '/alerts/data/forecast.geojson');
});

test('dashboard host serves DFENS Simple from /simple/', () => {
  assert.equal(
    rewrite(eventFor('dashboard.landslidesncgs.org', '/')).uri,
    '/simple/index.html'
  );
  assert.equal(
    rewrite(eventFor('dashboard.landslidesncgs.org', '/js/app.js')).uri,
    '/simple/js/app.js'
  );
  assert.equal(
    rewrite(eventFor('dashboard.landslidesncgs.org', '/data/status.json')).uri,
    '/simple/data/status.json'
  );
});

test('dashboard host leaves the shared alerts data files alone', () => {
  const out = rewrite(
    eventFor(
      'dashboard.landslidesncgs.org',
      '/alerts/data/buildings/manifest.json'
    )
  );
  assert.equal(out.uri, '/alerts/data/buildings/manifest.json');
});

test('dashboard host sends retired alerts pages to its root', () => {
  const out = rewrite(eventFor('dashboard.landslidesncgs.org', '/alerts/'));
  assert.equal(out.statusCode, 301);
  assert.equal(out.headers.location.value, '/');
});

test('dashboard host strips a doubled /simple prefix', () => {
  assert.equal(
    rewrite(eventFor('dashboard.landslidesncgs.org', '/simple/')).headers
      .location.value,
    '/'
  );
  assert.equal(
    rewrite(eventFor('dashboard.landslidesncgs.org', '/simple')).headers
      .location.value,
    '/'
  );
  assert.equal(
    rewrite(eventFor('dashboard.landslidesncgs.org', '/simple/js/app.js'))
      .headers.location.value,
    '/js/app.js'
  );
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

for (const page of [
  'about',
  'downloads',
  'reducing-landslide-risk',
  'learn-more',
]) {
  test('old flat page /' + page + '.html redirects to its directory', () => {
    const out = rewrite(eventFor('landslidesncgs.org', '/' + page + '.html'));
    assert.equal(out.statusCode, 301);
    assert.equal(out.headers.location.value, '/' + page + '/');
  });
}

test('old flat page redirect keeps the query string', () => {
  const out = rewrite(
    eventFor('landslidesncgs.org', '/about.html', {
      querystring: { utm: { value: 'x' } },
    })
  );
  assert.equal(out.headers.location.value, '/about/?utm=x');
});

test('moved page directory URL gets index.html', () => {
  assert.equal(
    rewrite(eventFor('landslidesncgs.org', '/about/')).uri,
    '/about/index.html'
  );
  assert.equal(
    rewrite(eventFor('landslidesncgs.org', '/about')).headers.location.value,
    '/about/'
  );
});

test('an .html file that did not move passes through', () => {
  assert.equal(
    rewrite(eventFor('landslidesncgs.org', '/index.html')).uri,
    '/index.html'
  );
  assert.equal(
    rewrite(eventFor('landslidesncgs.org', '/about/index.html')).uri,
    '/about/index.html'
  );
  assert.equal(
    rewrite(eventFor('landslidesncgs.org', '/other.html')).uri,
    '/other.html'
  );
});

test('dashboard host does not apply the moved page redirects', () => {
  assert.equal(
    rewrite(eventFor('dashboard.landslidesncgs.org', '/about.html')).uri,
    '/simple/about.html'
  );
});

for (const uri of [
  '/intro-landslides.html',
  '/intro-landslides',
  '/intro-landslides/',
  '/intro-landslides/index.html',
  '/data-tour.html',
  '/data-tour/',
]) {
  test('retired page ' + uri + ' answers 410 Gone', () => {
    const out = rewrite(eventFor('landslidesncgs.org', uri));
    assert.equal(out.statusCode, 410);
    assert.equal(out.headers['content-type'].value, 'text/plain');
  });
}

test('a path that merely starts with a retired page name passes through', () => {
  assert.equal(
    rewrite(eventFor('landslidesncgs.org', '/data-tour-2/')).uri,
    '/data-tour-2/index.html'
  );
  assert.equal(
    rewrite(
      eventFor('landslidesncgs.org', '/assets/images/intro-landslides/x.png')
    ).uri,
    '/assets/images/intro-landslides/x.png'
  );
});

test('dashboard host does not apply the retired page response', () => {
  assert.equal(
    rewrite(eventFor('dashboard.landslidesncgs.org', '/data-tour/')).uri,
    '/simple/data-tour/index.html'
  );
});
