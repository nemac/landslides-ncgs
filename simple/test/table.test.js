// table.js: row order, the rendered table, and the CSV export.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { loadScripts } = require('./load-script');

const { DFS_TABLE: TABLE } = loadScripts(['config.js', 'table.js'], {
  location: { search: '' },
});

function feature(props) {
  return { type: 'Feature', geometry: null, properties: props };
}

const SWANNANOA = feature({
  OBJECTID: 301,
  county: 'Buncombe',
  watershed: 'Swannanoa River',
  max_category: 11,
  area_acres: 0.42,
});
const PIGEON = feature({
  OBJECTID: 102,
  county: 'Haywood',
  watershed: 'Pigeon River, East Fork',
  max_category: 12,
  area_acres: 3.75,
});
const FRENCH_BROAD = feature({
  OBJECTID: 205,
  county: 'Buncombe',
  watershed: 'French Broad River',
  max_category: 11,
  area_acres: 12.0,
});

// ---- sortFeatures ---------------------------------------------------------
test('rows sort by forecast rain, then county, then pathway ID', () => {
  const sorted = TABLE.sortFeatures([SWANNANOA, PIGEON, FRENCH_BROAD]);
  assert.deepEqual(
    sorted.map((f) => f.properties.OBJECTID),
    [102, 205, 301]
  );
});

test('sortFeatures leaves the input array untouched', () => {
  const input = [SWANNANOA, PIGEON];
  TABLE.sortFeatures(input);
  assert.deepEqual(input, [SWANNANOA, PIGEON]);
});

test('a missing county sorts first and a missing ID sorts as zero', () => {
  const noCounty = feature({ OBJECTID: 9, max_category: 11 });
  const noId = feature({ county: 'Avery', max_category: 11 });
  const sorted = TABLE.sortFeatures([SWANNANOA, noId, noCounty]);
  assert.deepEqual(sorted, [noCounty, noId, SWANNANOA]);
});

// ---- render ---------------------------------------------------------------
function tableParts() {
  const dom = new JSDOM(
    '<table><tbody id="tbody"></tbody></table><p id="summary"></p>'
  );
  const doc = dom.window.document;
  const scoped = loadScripts(['config.js', 'table.js'], {
    location: { search: '' },
    document: doc,
  });
  return {
    TABLE: scoped.DFS_TABLE,
    tbody: doc.getElementById('tbody'),
    summary: doc.getElementById('summary'),
  };
}

test('render writes one clickable row per pathway and a summary', () => {
  const t = tableParts();
  const picked = [];
  t.TABLE.render([PIGEON, FRENCH_BROAD, SWANNANOA], t.tbody, t.summary, (id) =>
    picked.push(id)
  );
  const rows = Array.from(t.tbody.querySelectorAll('tr'));
  assert.equal(rows.length, 3);
  assert.deepEqual(
    Array.from(rows[0].cells).map((td) => td.textContent),
    ['Haywood', 'Pigeon River, East Fork', '6–8″', '3.8', '102']
  );
  assert.equal(rows[0].dataset.objectid, '102');
  assert.equal(rows[0].tabIndex, 0);
  assert.equal(
    rows[0].getAttribute('aria-label'),
    'Show pathway 102 in Haywood on the map'
  );
  assert.ok(rows[0].cells[3].classList.contains('num'));
  assert.ok(rows[0].cells[4].classList.contains('num'));
  assert.equal(t.summary.textContent, '3 pathways in 2 counties.');
  assert.ok(!t.summary.classList.contains('is-none'));

  rows[1].click();
  assert.deepEqual(picked, [205]);
});

test('Enter and Space on a row select it; other keys do not', () => {
  const t = tableParts();
  const picked = [];
  t.TABLE.render([SWANNANOA], t.tbody, t.summary, (id) => picked.push(id));
  const row = t.tbody.querySelector('tr');
  const KeyboardEvent = row.ownerDocument.defaultView.KeyboardEvent;
  for (const key of ['Enter', ' ', 'Tab']) {
    row.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  }
  assert.deepEqual(picked, [301, 301]);
});

test('render with no pathways shows the none-flagged message', () => {
  const t = tableParts();
  t.TABLE.render([], t.tbody, t.summary, () => {});
  const td = t.tbody.querySelector('td');
  assert.equal(td.colSpan, 5);
  assert.ok(td.classList.contains('empty-row'));
  assert.ok(td.classList.contains('is-none'));
  assert.match(td.textContent, /No debris flow pathways .* 5 inches or more/);
  assert.equal(t.summary.textContent, 'None flagged.');
  assert.ok(t.summary.classList.contains('is-none'));
});

test('render replaces earlier rows and clears the none-flagged state', () => {
  const t = tableParts();
  t.TABLE.render([], t.tbody, t.summary, () => {});
  t.TABLE.render([SWANNANOA], t.tbody, t.summary, () => {});
  assert.equal(t.tbody.querySelectorAll('tr').length, 1);
  assert.equal(t.summary.textContent, '1 pathway in 1 county.');
  assert.ok(!t.summary.classList.contains('is-none'));
});

test('render shows dashes for missing county, watershed and category', () => {
  const t = tableParts();
  const bare = feature({ OBJECTID: 5, max_category: 99 });
  t.TABLE.render([bare], t.tbody, t.summary, () => {});
  const cells = Array.from(t.tbody.querySelector('tr').cells).map(
    (td) => td.textContent
  );
  assert.deepEqual(cells, ['--', '--', '--', '--', '5']);
  assert.equal(
    t.tbody.querySelector('tr').getAttribute('aria-label'),
    'Show pathway 5 in unknown county on the map'
  );
  assert.equal(t.summary.textContent, '1 pathway in 0 counties.');
});

// ---- toCSV ----------------------------------------------------------------
const CTX = {
  windowStart: '2026-10-27T18:00:00+00:00',
  windowEnd: '2026-10-28T18:00:00+00:00',
  issued: '2026-10-27T18:11:16+00:00',
};

test('toCSV writes a header, one CRLF row per pathway and a trailing CRLF', () => {
  const csv = TABLE.toCSV([PIGEON, SWANNANOA], CTX);
  const lines = csv.split('\r\n');
  assert.equal(lines.pop(), '', 'ends with CRLF');
  assert.equal(
    lines[0],
    'county,watershed,forecast_rain,ndfd_category,area_acres,pathway_id,' +
      'window_start_utc,window_end_utc,nws_updated_utc,exported_utc'
  );
  assert.equal(lines.length, 3);
  assert.ok(!csv.includes('\n\n'));
});

test('toCSV quotes fields with commas or quotes and keeps the context columns', () => {
  const quoted = feature({
    OBJECTID: 7,
    county: 'Say "Hi"',
    watershed: 'Pigeon River, East Fork',
    max_category: 12,
    area_acres: 3.75,
  });
  const row = TABLE.toCSV([quoted], CTX).split('\r\n')[1];
  const cols = row
    .match(/("([^"]|"")*"|[^,]*)(,|$)/g)
    .map((c) => c.replace(/,$/, ''));
  assert.equal(cols[0], '"Say ""Hi"""');
  assert.equal(cols[1], '"Pigeon River, East Fork"');
  assert.equal(cols[2], '6–8″');
  assert.equal(cols[3], '12');
  assert.equal(cols[4], '3.8');
  assert.equal(cols[5], '7');
  assert.equal(cols[6], CTX.windowStart);
  assert.equal(cols[7], CTX.windowEnd);
  assert.equal(cols[8], CTX.issued);
  assert.match(cols[9], /^\d{4}-\d{2}-\d{2}T.*Z$/);
});

test('toCSV rounds acres to two places under one acre and one above', () => {
  const rows = TABLE.toCSV([SWANNANOA, FRENCH_BROAD], CTX).split('\r\n');
  assert.equal(rows[1].split(',')[4], '0.42');
  assert.equal(rows[2].split(',')[4], '12.0');
});

test('toCSV leaves unknown values blank and non-numeric acres as dashes', () => {
  const bare = feature({ OBJECTID: 5, max_category: 99, area_acres: 'n/a' });
  const row = TABLE.toCSV([bare], {}).split('\r\n')[1];
  assert.equal(row.split(',').slice(0, 9).join(','), ',,,99,--,5,,,');
});
