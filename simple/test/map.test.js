// map.js against a Leaflet stand-in: what each public call asks Leaflet to
// draw, the NDFD period filter, the popups, the parcel owner parser, and
// the per-county buildings loader with its cache.
const { test, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { loadScripts } = require('./load-script');
const { fakeLeaflet } = require('./fake-leaflet');
const {
  fixture,
  okResponse,
  errorResponse,
  FIXED_NOW,
} = require('./load-page');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

// Values built inside the sandbox have that realm's prototypes, which
// strict deepEqual rejects; compare them as plain data.
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

// The tile layers map.js adds on demand, not the two basemap tile layers
// init() builds for the selector.
function overlayTiles(m) {
  return m.created.tileLayers.filter(
    (l) => !/openstreetmap|World_Imagery/.test(l.url)
  );
}

function settle() {
  return new Promise((r) => setImmediate(r)).then(
    () => new Promise((r) => setImmediate(r))
  );
}

// A fresh map.js with its own fake Leaflet and a copy of the page's DOM.
function mapModule(options) {
  const opts = options || {};
  const dom = new JSDOM(HTML, { url: 'http://localhost:8000/simple/' });
  const document = dom.window.document;
  const { L, created } = fakeLeaflet(document);
  const fetchCalls = [];
  const warnings = [];
  const sandbox = loadScripts(['config.js', 'map.js'], {
    location: { search: '' },
    document,
    L,
    Date: globalThis.Date,
    setTimeout: globalThis.setTimeout,
    fetch(url) {
      fetchCalls.push(url);
      const answer = opts.fetch ? opts.fetch(url) : undefined;
      if (answer === undefined) return Promise.resolve(errorResponse(404));
      return Promise.resolve(answer).then((a) =>
        a && typeof a.ok === 'boolean' ? a : okResponse(a)
      );
    },
    console: {
      log() {},
      time() {},
      timeEnd() {},
      warn: (...a) => warnings.push(a.join(' ')),
      error: (...a) => warnings.push(a.join(' ')),
    },
  });
  const MAP = sandbox.DFS_MAP;
  const map = MAP.init();
  return { MAP, map, L, created, document, fetchCalls, warnings, dom };
}

beforeEach(() => {
  mock.timers.enable({ apis: ['Date', 'setTimeout'], now: FIXED_NOW });
});
afterEach(() => mock.timers.reset());

const LIVE_META = fixture('live').flagged.meta;

// ---- init -----------------------------------------------------------------
test('init creates the map at the configured view with one pane per layer', () => {
  const m = mapModule();
  assert.deepEqual(plain(m.map.options.center), [35.55, -82.55]);
  assert.equal(m.map.options.zoom, 8);
  assert.equal(m.created.maps.length, 1);
});

test('each layer gets a pane at its configured z-index; only alerts and parcels are clickable', () => {
  const m = mapModule();
  const panes = m.map.panes;
  assert.deepEqual(Object.keys(panes).sort(), [
    'alertsPane',
    'buildingsPane',
    'forecastPane',
    'ncgs_referencePane',
    'observedPane',
    'parcelsPane',
    'radarPane',
  ]);
  assert.equal(panes.alertsPane.style.zIndex, '430');
  assert.equal(panes.buildingsPane.style.zIndex, '380');
  for (const [name, el] of Object.entries(panes)) {
    const clickable = name === 'alertsPane' || name === 'parcelsPane';
    assert.equal(el.style.pointerEvents, clickable ? '' : 'none', name);
  }
});

test('the light Esri basemap with labels is on by default and a selector is added', () => {
  const m = mapModule();
  const onMap = Array.from(m.map.layers);
  assert.equal(onMap.length, 1);
  assert.deepEqual(
    Array.from(onMap[0].members).map((l) => l.basemap),
    ['Gray', 'GrayLabels']
  );
  assert.deepEqual(Object.keys(m.map.layersControl.basemaps), [
    'Light (Esri Gray)',
    'Dark (Esri Dark Gray)',
    'Streets (OpenStreetMap)',
    'Satellite (Esri World Imagery)',
  ]);
  assert.equal(m.map.layersControl.opts.position, 'topright');
});

test('init warns and carries on when the geocoder plugin is missing', () => {
  const m = mapModule();
  assert.ok(m.warnings.some((w) => /geocoder not loaded/.test(w)));
});

// ---- NDFD forecast layer --------------------------------------------------
test('the NDFD filter picks the six-hour period ending at window_end, give or take a minute', () => {
  const where = mapModule().MAP._test.forecastWhere(
    '2026-10-28T18:00:00+00:00'
  );
  assert.equal(
    where,
    "fromdate >= timestamp '2026-10-28 11:59:00' AND " +
      "fromdate <= timestamp '2026-10-28 12:01:00'"
  );
});

test('setForecastPeriod draws the NDFD layer for the window and colors by category', () => {
  const m = mapModule();
  m.MAP.setForecastPeriod(LIVE_META);
  assert.equal(m.created.featureLayers.length, 1);
  const fl = m.created.featureLayers[0];
  assert.match(fl.options.url, /NDFD_Precipitation_v1\/FeatureServer\/1$/);
  assert.equal(
    fl.options.where,
    m.MAP._test.forecastWhere(LIVE_META.window_end)
  );
  assert.equal(fl.options.pane, 'forecastPane');
  assert.deepEqual(plain(fl.options.fields), ['OBJECTID', 'category', 'label']);
  assert.ok(m.map.hasLayer(fl), 'added because the checkbox is checked');
  assert.equal(
    fl.options.style({ properties: { category: 11 } }).fillColor,
    '#F59E0B'
  );
  assert.equal(
    fl.options.style({ properties: { category: 42 } }).fillColor,
    '#888'
  );
});

test('the same window does not rebuild the layer; a new issue time does', () => {
  const m = mapModule();
  m.MAP.setForecastPeriod(LIVE_META);
  m.MAP.setForecastPeriod({ ...LIVE_META });
  assert.equal(m.created.featureLayers.length, 1);
  m.MAP.setForecastPeriod({
    ...LIVE_META,
    issued: '2026-10-27T19:11:00+00:00',
  });
  assert.equal(m.created.featureLayers.length, 2);
  assert.ok(!m.map.hasLayer(m.created.featureLayers[0]), 'old layer removed');
  assert.ok(m.map.hasLayer(m.created.featureLayers[1]));
});

test('setForecastPeriod ignores missing meta and leaves the layer off when unchecked', () => {
  const m = mapModule();
  m.MAP.setForecastPeriod(null);
  m.MAP.setForecastPeriod({ window_start: 'x' });
  assert.equal(m.created.featureLayers.length, 0);
  m.document.getElementById('layer-ndfd').checked = false;
  m.MAP.setForecastPeriod(LIVE_META);
  assert.equal(m.created.featureLayers.length, 1);
  assert.ok(!m.map.hasLayer(m.created.featureLayers[0]));
});

test('setForecastVisible toggles the layer and is a no-op before a period is set', () => {
  const m = mapModule();
  m.MAP.setForecastVisible(true);
  m.MAP.setForecastPeriod(LIVE_META);
  const fl = m.created.featureLayers[0];
  m.MAP.setForecastVisible(false);
  assert.ok(!m.map.hasLayer(fl));
  m.MAP.setForecastVisible(true);
  assert.ok(m.map.hasLayer(fl));
});

test('a hidden forecast layer stays hidden across a new period', () => {
  const m = mapModule();
  m.MAP.setForecastPeriod(LIVE_META);
  m.MAP.setForecastVisible(false);
  m.MAP.setForecastPeriod({ ...LIVE_META, issued: 'later' });
  assert.ok(!m.map.hasLayer(m.created.featureLayers[1]));
});

test('an NDFD request error shows the map notice; success clears it', () => {
  const m = mapModule();
  m.MAP.setForecastPeriod(LIVE_META);
  const fl = m.created.featureLayers[0];
  fl.fire('requesterror', { error: new Error('503') });
  assert.equal(m.map.controls.size, 1);
  const notice = Array.from(m.map.controls)[0];
  assert.equal(notice.el.className, 'map-notice');
  assert.equal(notice.el.getAttribute('role'), 'status');
  assert.match(
    notice.el.textContent,
    /could not be loaded from the NWS service/
  );
  fl.fire('requesterror', { error: new Error('again') });
  assert.equal(m.map.controls.size, 1, 'one notice, not two');
  fl.fire('requestsuccess');
  assert.equal(m.map.controls.size, 0);
  assert.ok(m.warnings.some((w) => /503/.test(w)));
});

// ---- Observed (MRMS) and radar tiles -------------------------------------
test('the MRMS tiles are stamped by ten-minute bucket and redrawn when it changes', () => {
  const m = mapModule();
  m.MAP.setObservedVisible(true);
  const tl = overlayTiles(m)[0];
  assert.match(tl.url, /q2-p24h.*\{t\}/);
  assert.equal(tl.options.pane, 'observedPane');
  assert.equal(tl.options.maxNativeZoom, 10);
  const stamp = tl.options.t;
  assert.equal(stamp, String(Math.floor(FIXED_NOW / 600000)));
  m.MAP.refreshObserved();
  assert.equal(tl.redraws, undefined, 'same bucket, no redraw');
  mock.timers.tick(10 * 60000);
  m.MAP.refreshObserved();
  assert.equal(tl.redraws, 1);
  assert.equal(tl.options.t, String(Number(stamp) + 1));
  m.MAP.setObservedVisible(false);
  assert.ok(!m.map.hasLayer(tl));
  m.MAP.refreshObserved();
  m.MAP.setObservedVisible(true);
  assert.equal(overlayTiles(m).length, 2, 'rebuilt after being removed');
});

test('the radar overlay is a NEXRAD tile layer in its own pane', () => {
  const m = mapModule();
  m.MAP.setRadarVisible(true);
  m.MAP.setRadarVisible(true);
  assert.equal(overlayTiles(m).length, 1);
  const tl = overlayTiles(m)[0];
  assert.match(tl.url, /nexrad-n0q/);
  assert.equal(tl.options.pane, 'radarPane');
  assert.ok(m.map.hasLayer(tl));
  m.MAP.setRadarVisible(false);
  assert.ok(!m.map.hasLayer(tl));
});

// ---- Flagged pathways -----------------------------------------------------
const FLAGGED = fixture('live').flagged;

test('setAlerts draws the pathways in the alerts pane with escaped popups', () => {
  const m = mapModule();
  const fc = JSON.parse(JSON.stringify(FLAGGED));
  fc.features[0].properties.county = 'Bun<b>combe</b>';
  m.MAP.setAlerts(fc);
  const gl = m.created.geoJsonLayers[0];
  assert.equal(gl.options.pane, 'alertsPane');
  assert.equal(gl.options.style.color, '#FF6A13');
  assert.ok(m.map.hasLayer(gl));
  assert.equal(gl.sub.length, 4);
  assert.match(gl.sub[0].popup, /<strong>Flagged pathway 301<\/strong>/);
  assert.match(gl.sub[0].popup, /Bun&lt;b&gt;combe&lt;\/b&gt;/);
  assert.match(gl.sub[0].popup, /<dt>Forecast rain<\/dt><dd>5–6″<\/dd>/);
  assert.match(gl.sub[3].popup, /<dd>4\.00–5\.00″<\/dd>/);
});

test('setAlerts with nothing removes the layer', () => {
  const m = mapModule();
  m.MAP.setAlerts(FLAGGED);
  const gl = m.created.geoJsonLayers[0];
  m.MAP.setAlerts({ type: 'FeatureCollection', features: [] });
  assert.ok(!m.map.hasLayer(gl));
  assert.equal(m.created.geoJsonLayers.length, 1);
  m.MAP.setAlerts(FLAGGED);
  m.MAP.setAlerts(null);
  assert.ok(!m.map.hasLayer(m.created.geoJsonLayers[1]));
});

test('zoomToAlert fits the pathway, re-shows a hidden layer and opens its popup', () => {
  const m = mapModule();
  m.MAP.zoomToAlert(205);
  assert.equal(m.map.fitted, undefined);
  m.MAP.setAlerts(FLAGGED);
  m.MAP.setAlertsVisible(false);
  m.MAP.zoomToAlert('205');
  const gl = m.created.geoJsonLayers[0];
  assert.ok(m.map.hasLayer(gl));
  assert.deepEqual(plain(m.map.fitted), {
    bounds: { of: 205 },
    opts: { padding: [60, 60], maxZoom: 15 },
  });
  assert.ok(
    gl.sub.find((l) => l.feature.properties.OBJECTID === 205).popupOpen
  );
  m.map.fitted = undefined;
  m.MAP.zoomToAlert(999);
  assert.equal(m.map.fitted, undefined);
});

test('setAlertsVisible toggles the drawn layer', () => {
  const m = mapModule();
  m.MAP.setAlertsVisible(true);
  m.MAP.setAlerts(FLAGGED);
  const gl = m.created.geoJsonLayers[0];
  m.MAP.setAlertsVisible(false);
  assert.ok(!m.map.hasLayer(gl));
  m.MAP.setAlertsVisible(true);
  assert.ok(m.map.hasLayer(gl));
});

// ---- NCGS reference layer -------------------------------------------------
test('the reference layer resolves when its first batch loads, once', async () => {
  const m = mapModule();
  let done = false;
  m.MAP.setReferenceVisible(true).then(() => {
    done = true;
  });
  const fl = m.created.featureLayers[0];
  assert.match(fl.options.url, /CDF_Landslides_Model\/FeatureServer\/0$/);
  assert.equal(fl.options.pane, 'ncgs_referencePane');
  assert.ok(m.map.hasLayer(fl));
  await settle();
  assert.equal(done, false);
  fl.fire('load');
  await settle();
  assert.equal(done, true);
  assert.deepEqual(fl._handlers.load, [], 'listener removed');

  let again = false;
  m.MAP.setReferenceVisible(true).then(() => {
    again = true;
  });
  await settle();
  assert.equal(again, true, 'already on resolves at once');
  assert.equal(m.created.featureLayers.length, 1);

  m.MAP.setReferenceVisible(false);
  assert.ok(!m.map.hasLayer(fl));
});

test('the reference layer gives up waiting after 30 seconds', async () => {
  const m = mapModule();
  let done = false;
  m.MAP.setReferenceVisible(true).then(() => {
    done = true;
  });
  mock.timers.tick(29999);
  await settle();
  assert.equal(done, false);
  mock.timers.tick(1);
  await settle();
  assert.equal(done, true);
});

// ---- Parcels --------------------------------------------------------------
test('the parcels layer is zoom-gated, asks for the popup fields and is clickable', () => {
  const m = mapModule();
  m.MAP.setParcelsVisible(true);
  m.MAP.setParcelsVisible(true);
  assert.equal(m.created.featureLayers.length, 1);
  const fl = m.created.featureLayers[0];
  assert.match(fl.options.url, /NC1Map_Parcels\/MapServer\/1$/);
  assert.equal(fl.options.minZoom, 14);
  assert.equal(fl.options.pane, 'parcelsPane');
  assert.ok(fl.options.fields.includes('ownname'));
  assert.equal(fl.options.style.fillOpacity, 0);
  assert.equal(typeof fl.popup, 'function');
  m.MAP.setParcelsVisible(false);
  assert.ok(!m.map.hasLayer(fl));
});

test('the parcel popup fills every field and escapes upstream text', () => {
  const build = mapModule().MAP._test.buildParcelPopup;
  const html = build({
    feature: {
      properties: {
        siteadd: '12 <Main> St',
        scity: 'ASHEVILLE',
        szip: '28801',
        parno: '9648-12-3456',
        cntyname: 'BUNCOMBE',
        gisacres: 1.2345,
        transfdate: Date.UTC(2024, 4, 17, 13),
        ownname: 'SMITH JOHN A',
      },
    },
  });
  assert.match(
    html,
    /<div class="parcel-popup-addr">12 &lt;Main&gt; St<\/div>/
  );
  assert.match(html, /<div class="parcel-popup-city">ASHEVILLE 28801<\/div>/);
  assert.match(html, /<dt>Owner<\/dt><dd>SMITH, JOHN A<\/dd>/);
  assert.match(html, /<dt>Parcel #<\/dt><dd>9648-12-3456<\/dd>/);
  assert.match(html, /<dt>Acres<\/dt><dd>1\.23 ac<\/dd>/);
  assert.match(html, /<dt>Updated<\/dt><dd>2024-05-17<\/dd>/);
});

test('the parcel popup shows dashes and a placeholder for missing fields', () => {
  const build = mapModule().MAP._test.buildParcelPopup;
  const html = build({
    feature: { properties: { siteadd: '  ', gisacres: 'n/a' } },
  });
  assert.match(html, /<em>No site address<\/em>/);
  assert.ok(!html.includes('parcel-popup-city'));
  assert.equal((html.match(/<dd>—<\/dd>/g) || []).length, 5);
  assert.match(build({}), /No site address/);
});

for (const [raw, want] of [
  ['SMITH JOHN A', 'SMITH, JOHN A'],
  ['SMITH JOHN', 'SMITH, JOHN'],
  ['  SMITH   JOHN ', 'SMITH, JOHN'],
  ['SMITH, JOHN', 'SMITH, JOHN'],
  ['SMITH', 'SMITH'],
  ['SMITH ENTERPRISES LLC', 'SMITH ENTERPRISES LLC'],
  ['Blue Ridge Church', 'Blue Ridge Church'],
  ['DOE FAMILY TRUST', 'DOE FAMILY TRUST'],
  ['ACME CO', 'ACME CO'],
  ['', null],
  [null, null],
]) {
  test(
    'owner name ' + JSON.stringify(raw) + ' reads as ' + JSON.stringify(want),
    () => {
      assert.equal(mapModule().MAP._test.parseOwnerName(raw), want);
    }
  );
}

for (const [placeType, zoom] of [
  ['PointAddress', 17],
  ['StreetAddress', 17],
  ['POI', 17],
  ['City', 12],
  ['Locality', 12],
  ['Neighborhood', 12],
  ['County', 9],
  ['State or Province', 9],
  ['Feature', 14],
  ['', 14],
  [undefined, 14],
]) {
  test(
    'a ' + JSON.stringify(placeType) + ' search result zooms to ' + zoom,
    () => {
      assert.equal(mapModule().MAP._test.zoomForPlaceType(placeType), zoom);
    }
  );
}

test('escape covers the five HTML metacharacters and stringifies', () => {
  const esc = mapModule().MAP._test.escape;
  assert.equal(
    esc('<a href="x" title=\'y\'>&</a>'),
    '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;'
  );
  assert.equal(esc(12), '12');
});

// ---- Buildings ------------------------------------------------------------
function county(geoid, bbox) {
  return {
    geoid,
    name: 'County ' + geoid,
    file: 'buildings/' + geoid + '.geojson',
    bbox,
  };
}
const INSIDE = county('37021', [-82.8, 35.2, -82.2, 35.8]);
const EDGE = county('37087', [-82.1, 35.9, -81.5, 36.5]);
const OUTSIDE = county('37001', [-80, 35, -79, 36]);
const BUILDING = {
  type: 'FeatureCollection',
  features: [{ type: 'Feature', geometry: null, properties: {} }],
};

function buildingsFixture(counties, failing) {
  return (url) => {
    if (url.endsWith('buildings/manifest.json')) {
      return { counties, total_features: 10, total_size_mb: 1 };
    }
    const geoid = (url.match(/buildings\/(\d+)\.geojson$/) || [])[1];
    if (!geoid || (failing || []).includes(geoid)) return undefined;
    return BUILDING;
  };
}

function buildingsOn(m) {
  m.document.getElementById('layer-buildings').checked = true;
  m.map.zoom = 12;
  m.MAP.setBuildingsVisible(true);
}

test('turning buildings on fetches the manifest, then the counties in view', async () => {
  const m = mapModule({ fetch: buildingsFixture([INSIDE, EDGE, OUTSIDE]) });
  buildingsOn(m);
  assert.deepEqual(m.fetchCalls, ['../alerts/data/buildings/manifest.json']);
  await settle();
  assert.deepEqual(m.fetchCalls.slice(1), [
    '../alerts/data/buildings/37021.geojson',
    '../alerts/data/buildings/37087.geojson',
  ]);
  await settle();
  assert.equal(m.created.geoJsonLayers.length, 2);
  const gl = m.created.geoJsonLayers[0];
  assert.equal(gl.options.pane, 'buildingsPane');
  assert.equal(gl.options.interactive, false);
  assert.ok(gl.options.renderer.canvas, 'shared canvas renderer');
  assert.equal(
    gl.options.renderer,
    m.created.geoJsonLayers[1].options.renderer
  );
});

test('buildings do not load below the minimum zoom, and load on zooming in', async () => {
  const m = mapModule({ fetch: buildingsFixture([INSIDE]) });
  m.document.getElementById('layer-buildings').checked = true;
  m.map.zoom = 11;
  m.MAP.setBuildingsVisible(true);
  await settle();
  assert.equal(m.fetchCalls.length, 1, 'manifest only');
  m.map.zoom = 12;
  m.map.fire('zoomend');
  await settle();
  assert.equal(m.fetchCalls.length, 2);
});

test('a county is fetched once even when the view moves while it is in flight', async () => {
  const m = mapModule({ fetch: buildingsFixture([INSIDE]) });
  buildingsOn(m);
  await settle();
  m.map.fire('moveend');
  m.map.fire('moveend');
  await settle();
  m.map.fire('moveend');
  await settle();
  assert.equal(m.fetchCalls.filter((u) => /37021/.test(u)).length, 1);
});

test('unchecking during the manifest fetch leaves the layer idle', async () => {
  const m = mapModule({ fetch: buildingsFixture([INSIDE]) });
  buildingsOn(m);
  m.document.getElementById('layer-buildings').checked = false;
  m.MAP.setBuildingsVisible(false);
  await settle();
  await settle();
  assert.equal(m.fetchCalls.length, 1, 'no county fetched');
});

test('a county that fails to load is skipped with a warning; the rest draw', async () => {
  const m = mapModule({ fetch: buildingsFixture([INSIDE, EDGE], ['37021']) });
  buildingsOn(m);
  await settle();
  await settle();
  assert.equal(m.created.geoJsonLayers.length, 1);
  assert.ok(m.warnings.some((w) => /county 37021/.test(w)));
});

test('toggling buildings off hides the pane and on again shows it without refetching', async () => {
  const m = mapModule({ fetch: buildingsFixture([INSIDE]) });
  buildingsOn(m);
  await settle();
  await settle();
  const pane = m.document.querySelector('.buildingsPane');
  assert.equal(pane, null, 'the fake map does not attach panes to the page');
  const before = m.fetchCalls.length;
  m.document.getElementById('layer-buildings').checked = false;
  m.MAP.setBuildingsVisible(false);
  m.document.getElementById('layer-buildings').checked = true;
  m.MAP.setBuildingsVisible(true);
  await settle();
  assert.equal(m.fetchCalls.length, before, 'cached county reused');
});

test('the county cache evicts the least recently seen county past its cap', async () => {
  const many = [];
  for (let i = 0; i < 22; i++) {
    many.push(county(String(37000 + i), [-82.8, 35.2, -82.2, 35.8]));
  }
  const m = mapModule({ fetch: buildingsFixture(many) });
  buildingsOn(m);
  await settle();
  await settle();
  assert.equal(m.created.geoJsonLayers.length, 22, 'all fetched');
  const group = Array.from(m.map.layers).find(
    (l) => l.members && !Array.from(l.members).some((x) => x.basemap)
  );
  assert.equal(
    group.members.size,
    22,
    'eviction runs on the next viewport update'
  );
  m.map.fire('moveend');
  assert.equal(group.members.size, 20);
});
