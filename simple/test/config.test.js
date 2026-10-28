// config.js: the data-folder overrides and the shape of the lookup tables
// the other modules index into. The pipeline-side sync of the shared
// numbers lives in simple/pipeline/test_config_sync.py.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadScripts } = require('./load-script');

function configWithSearch(search) {
  return loadScripts(['config.js'], { location: { search } }).DFS_CONFIG;
}

test('dataBase and buildingsBase default to the folders next to the page', () => {
  const cfg = configWithSearch('');
  assert.equal(cfg.dataBase(), 'data/');
  assert.equal(cfg.buildingsBase(), '../alerts/data/');
});

test('?data= and ?buildings= override the folders for testing', () => {
  const cfg = configWithSearch('?data=/fixtures/live/&buildings=/other/');
  assert.equal(cfg.dataBase(), '/fixtures/live/');
  assert.equal(cfg.buildingsBase(), '/other/');
});

test('an override without a trailing slash gets one', () => {
  const cfg = configWithSearch('?data=https://example.org/simple/data');
  assert.equal(cfg.dataBase(), 'https://example.org/simple/data/');
});

test('a broken location falls back to the defaults', () => {
  const location = {
    get search() {
      throw new Error('no location');
    },
  };
  const cfg = loadScripts(['config.js'], { location }).DFS_CONFIG;
  assert.equal(cfg.dataBase(), 'data/');
});

test('every NDFD category has both a label and a color', () => {
  const cfg = configWithSearch('');
  const categories = Array.from({ length: 20 }, (_, i) => i);
  assert.deepEqual(Object.keys(cfg.PRECIP_LABELS).map(Number), categories);
  assert.deepEqual(Object.keys(cfg.PRECIP_COLORS).map(Number), categories);
  for (const c of categories) {
    assert.match(cfg.PRECIP_COLORS[c], /^#[0-9A-Fa-f]{6}$/, 'color ' + c);
  }
});

test('the threshold category is within the label table', () => {
  const cfg = configWithSearch('');
  assert.ok(cfg.PRECIP_LABELS[cfg.THRESHOLD_CATEGORY]);
  assert.match(cfg.PRECIP_LABELS[cfg.THRESHOLD_CATEGORY], /^5/);
});

test('flagged pathways stack above every other map pane', () => {
  const z = configWithSearch('').PANE_ZINDEX;
  for (const [name, value] of Object.entries(z)) {
    if (name !== 'alerts') assert.ok(z.alerts > value, name);
  }
  assert.ok(z.radar > z.forecast, 'radar draws over the forecast');
  assert.ok(z.forecast > z.parcels && z.parcels > z.buildings);
});

test('the MRMS ramp and ticks are in order and within the bar', () => {
  const cfg = configWithSearch('');
  const stops = cfg.MRMS_24H_RAMP.map((s) => s[0]);
  assert.equal(stops[0], 0);
  assert.equal(stops[stops.length - 1], 100);
  for (let i = 1; i < stops.length; i++) assert.ok(stops[i] >= stops[i - 1]);
  for (const [pos] of cfg.MRMS_24H_TICKS) assert.ok(pos > 0 && pos < 100);
});
