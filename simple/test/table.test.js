// table.js: row order, the two table modes (grouped by fire district, or a
// plain list when the districts are not known), the notice, the caption,
// the empty and message states, and the CSV export.
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

const ASHEVILLE = {
  fdid: '11101',
  fire_department: 'Asheville Fire Department',
  fd_county: 'Buncombe',
  fd_address: '100 Court Plaza, Asheville, NC 28801',
  district_updated: '2024-03-01',
  fire_district_status: 'district',
};
const CRUSO = {
  fdid: '44104',
  fire_department: 'Cruso Fire Department',
  fd_county: 'Haywood',
  fd_address: '13 Cruso Rd, Canton, NC 28716',
  district_updated: '2023-07-15',
  fire_district_status: 'district',
};
const NO_DISTRICT = {
  fdid: null,
  fire_department: null,
  fd_county: 'Swain',
  fd_address: null,
  district_updated: '2022-01-10',
  fire_district_status: 'no_district',
};
const OUTSIDE_NC = {
  fdid: null,
  fire_department: null,
  fd_county: null,
  fd_address: null,
  district_updated: null,
  fire_district_status: 'outside_nc',
};

function pathway(id, county, watershed, category, acres, fire) {
  return feature(
    Object.assign(
      {
        OBJECTID: id,
        county: county,
        watershed: watershed,
        max_category: category,
        area_acres: acres,
      },
      fire
    )
  );
}

// The three pathways of the plain (older) file, with no fire fields.
const SWANNANOA = pathway(301, 'Buncombe', 'Swannanoa River', 11, 0.42, {});
const PIGEON = pathway(102, 'Haywood', 'Pigeon River, East Fork', 12, 3.75, {});
const FRENCH_BROAD = pathway(205, 'Buncombe', 'French Broad River', 11, 12, {});

const OK_META = { fire_districts: 'ok' };

function ids(features) {
  return Array.from(features, (f) => f.properties.OBJECTID);
}

// ---- sortFeatures ---------------------------------------------------------
test('rows sort by forecast rain, then county, then pathway ID', () => {
  const sorted = TABLE.sortFeatures([SWANNANOA, PIGEON, FRENCH_BROAD]);
  assert.deepEqual(ids(sorted), [102, 205, 301]);
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

// ---- districtsKnown -------------------------------------------------------
const KNOWN_SET = [
  pathway(1, 'Buncombe', 'A', 11, 1, ASHEVILLE),
  pathway(2, 'Swain', 'B', 11, 1, NO_DISTRICT),
  pathway(3, 'Cocke', 'C', 11, 1, OUTSIDE_NC),
];

test('districts are known only when the lookup ran and every status is valid', () => {
  assert.equal(TABLE.districtsKnown(KNOWN_SET, OK_META), true);
});

for (const [label, meta] of [
  ['unavailable', { fire_districts: 'unavailable' }],
  ['not_run with features', { fire_districts: 'not_run' }],
  ['missing', {}],
  ['a missing meta object', undefined],
]) {
  test(
    'meta.fire_districts ' + label + ' means districts are not known',
    () => {
      assert.equal(TABLE.districtsKnown(KNOWN_SET, meta), false);
    }
  );
}

for (const [label, status] of [
  ['missing', undefined],
  ['null', null],
  ['unrecognised', 'somewhere'],
]) {
  test('one pathway with a ' + label + ' status means not known', () => {
    const bad = pathway(4, 'Buncombe', 'D', 11, 1, {
      ...ASHEVILLE,
      fire_district_status: status,
    });
    assert.equal(TABLE.districtsKnown([...KNOWN_SET, bad], OK_META), false);
  });
}

// ---- groupFeatures --------------------------------------------------------
test('real districts sort by rain, then size, then name; special groups go last', () => {
  const features = [
    pathway(10, 'Swain', 'W', 13, 1, NO_DISTRICT),
    pathway(11, 'Cocke', 'X', 14, 1, OUTSIDE_NC),
    pathway(12, 'Buncombe', 'Y', 11, 1, ASHEVILLE),
    pathway(13, 'Buncombe', 'Y', 11, 1, ASHEVILLE),
    pathway(14, 'Haywood', 'Z', 11, 1, CRUSO),
    pathway(15, 'Haywood', 'Z', 12, 1, {
      ...CRUSO,
      fdid: '44999',
      fire_department: 'Bethel Fire Department',
    }),
    pathway(16, 'Haywood', 'Z', 11, 1, {
      ...CRUSO,
      fdid: '44555',
      fire_department: 'Allens Creek Fire Department',
    }),
  ];
  const groups = TABLE.groupFeatures(features);
  assert.deepEqual(
    Array.from(groups, (g) => g.name),
    [
      'Bethel Fire Department', // highest rain
      'Asheville Fire Department', // two pathways
      'Allens Creek Fire Department', // then by name
      'Cruso Fire Department',
      'No District',
      'Outside North Carolina',
    ]
  );
  assert.deepEqual(
    Array.from(groups, (g) => g.kind),
    [
      'district',
      'district',
      'district',
      'district',
      'no_district',
      'outside_nc',
    ]
  );
  assert.deepEqual(ids(groups[1].features), [12, 13]);
  assert.equal(groups[0].maxCat, 12);
});

test('a real district with no FDID is grouped by its name', () => {
  const noId = { ...CRUSO, fdid: null, fire_department: 'Maggie Valley FD' };
  const groups = TABLE.groupFeatures([
    pathway(1, 'Haywood', 'A', 11, 1, noId),
    pathway(2, 'Haywood', 'B', 11, 1, noId),
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].key, 'name:Maggie Valley FD');
  assert.equal(groups[0].fdid, null);
});

test('special groups only appear when they have pathways', () => {
  const groups = TABLE.groupFeatures([
    pathway(1, 'Swain', 'A', 11, 1, NO_DISTRICT),
  ]);
  assert.deepEqual(
    Array.from(groups, (g) => g.name),
    ['No District']
  );
});

// ---- render ---------------------------------------------------------------
function tableParts() {
  const dom = new JSDOM(
    '<table id="t"><caption>Loading</caption><thead><tr><th>x</th></tr></thead>' +
      '<tbody><tr><td>Loading</td></tr></tbody></table>' +
      '<p id="summary"></p><div id="notice" role="status"></div>'
  );
  const doc = dom.window.document;
  const scoped = loadScripts(['config.js', 'table.js'], {
    location: { search: '' },
    document: doc,
  });
  const elements = {
    table: doc.getElementById('t'),
    summary: doc.getElementById('summary'),
    notice: doc.getElementById('notice'),
  };
  const picked = [];
  const zoomed = [];
  const handlers = {
    onSelect: (id) => picked.push(id),
    onZoomGroup: (list) => zoomed.push(Array.from(list)),
  };
  return {
    TABLE: scoped.DFS_TABLE,
    doc,
    elements,
    handlers,
    picked,
    zoomed,
    window: dom.window,
    render(features, meta) {
      scoped.DFS_TABLE.render(features, meta, elements, handlers);
    },
    bodies: () => Array.from(elements.table.tBodies),
    pathwayRows: () =>
      Array.from(elements.table.querySelectorAll('tr[data-objectid]')),
    headings: () =>
      Array.from(elements.table.querySelectorAll('.group-row th')),
  };
}

// ---- Plain list (districts not known) -------------------------------------
test('without the marker the table is a plain sorted list in one body', () => {
  const t = tableParts();
  t.render([SWANNANOA, PIGEON, FRENCH_BROAD], {});
  assert.equal(t.bodies().length, 1);
  assert.equal(t.headings().length, 0);
  const rows = t.pathwayRows();
  assert.deepEqual(
    rows.map((r) => r.dataset.objectid),
    ['102', '205', '301']
  );
  assert.deepEqual(
    Array.from(rows[0].cells).map((td) => td.textContent),
    ['Haywood', 'Pigeon River, East Fork', '6–8″', '3.8', '102']
  );
  assert.equal(rows[0].tabIndex, 0);
  assert.equal(
    rows[0].getAttribute('aria-label'),
    'Show pathway 102 in Haywood on the map'
  );
  assert.ok(rows[0].cells[3].classList.contains('num'));
  assert.ok(rows[0].cells[4].classList.contains('num'));
  assert.equal(t.elements.summary.textContent, '3 pathways in 2 counties');
  assert.ok(!t.elements.summary.classList.contains('is-none'));

  rows[1].click();
  assert.deepEqual(t.picked, [205]);
});

test('the plain list shows the notice in the status region', () => {
  const t = tableParts();
  t.render([SWANNANOA], { fire_districts: 'unavailable' });
  assert.equal(
    t.elements.notice.textContent,
    'Fire district information is unavailable right now. ' +
      'Pathways are listed without districts.'
  );
  assert.equal(t.elements.notice.getAttribute('role'), 'status');
});

test('the notice is not rewritten when it already says the same thing', () => {
  const t = tableParts();
  t.render([SWANNANOA], {});
  const first = t.elements.notice.firstChild;
  t.render([SWANNANOA, PIGEON], {});
  assert.equal(t.elements.notice.firstChild, first);
});

test('the plain list caption does not mention districts', () => {
  const t = tableParts();
  t.render([SWANNANOA], {});
  const caption = t.elements.table.caption.textContent;
  assert.match(caption, /highest rain first\. Select a row to show/);
  assert.doesNotMatch(caption, /district/);
});

test('one pathway with a bad status turns the whole table into the plain list', () => {
  const t = tableParts();
  t.render(
    [
      pathway(1, 'Buncombe', 'A', 11, 1, ASHEVILLE),
      pathway(2, 'Buncombe', 'B', 11, 1, {
        ...ASHEVILLE,
        fire_district_status: 'x',
      }),
    ],
    OK_META
  );
  assert.equal(t.headings().length, 0);
  assert.equal(t.elements.summary.textContent, '2 pathways in 1 county');
  assert.notEqual(t.elements.notice.textContent, '');
});

test('"not_run" with pathways is treated as not known', () => {
  const t = tableParts();
  t.render([pathway(1, 'Buncombe', 'A', 11, 1, ASHEVILLE)], {
    fire_districts: 'not_run',
  });
  assert.equal(t.headings().length, 0);
  assert.notEqual(t.elements.notice.textContent, '');
});

test('Enter and Space on a row select it; other keys do not', () => {
  const t = tableParts();
  t.render([SWANNANOA], {});
  const row = t.pathwayRows()[0];
  for (const key of ['Enter', ' ', 'Tab']) {
    row.dispatchEvent(
      new t.window.KeyboardEvent('keydown', { key, bubbles: true })
    );
  }
  assert.deepEqual(t.picked, [301, 301]);
});

test('render shows dashes for missing county, watershed and category', () => {
  const t = tableParts();
  t.render([feature({ OBJECTID: 5, max_category: 99 })], {});
  const row = t.pathwayRows()[0];
  assert.deepEqual(
    Array.from(row.cells).map((td) => td.textContent),
    ['--', '--', '--', '--', '5']
  );
  assert.equal(
    row.getAttribute('aria-label'),
    'Show pathway 5 in unknown county on the map'
  );
  assert.equal(t.elements.summary.textContent, '1 pathway in 0 counties');
});

// ---- Empty state ----------------------------------------------------------
test('render with no pathways shows the none-flagged message and no notice', () => {
  const t = tableParts();
  t.render([], {});
  assert.equal(t.bodies().length, 1);
  const td = t.elements.table.querySelector('td');
  assert.equal(td.colSpan, 5);
  assert.ok(td.classList.contains('empty-row'));
  assert.ok(td.classList.contains('is-none'));
  assert.match(td.textContent, /No debris flow pathways .* 5 inches or more/);
  assert.equal(t.elements.summary.textContent, 'None flagged');
  assert.ok(t.elements.summary.classList.contains('is-none'));
  assert.equal(t.elements.notice.textContent, '');
});

test('render replaces earlier rows and clears the none-flagged state', () => {
  const t = tableParts();
  t.render([], {});
  t.render([SWANNANOA], {});
  assert.equal(t.bodies().length, 1);
  assert.equal(t.pathwayRows().length, 1);
  assert.equal(t.elements.summary.textContent, '1 pathway in 1 county');
  assert.ok(!t.elements.summary.classList.contains('is-none'));
});

// ---- Grouped (districts known) --------------------------------------------
const LIVE_LIKE = [
  pathway(301, 'Buncombe', 'Swannanoa River', 11, 0.42, ASHEVILLE),
  pathway(102, 'Haywood', 'Pigeon River, East Fork', 12, 3.75, CRUSO),
  pathway(205, 'Buncombe', 'French Broad River', 11, 12, ASHEVILLE),
];

test('known districts give one body per group, each led by a rowgroup heading', () => {
  const t = tableParts();
  t.render(LIVE_LIKE, OK_META);
  const bodies = t.bodies();
  assert.equal(bodies.length, 2);
  for (const body of bodies) {
    const th = body.rows[0].querySelector('th');
    assert.equal(th.getAttribute('scope'), 'rowgroup');
    assert.equal(th.colSpan, 5);
    assert.ok(th.querySelector('button.group-toggle'));
    assert.ok(th.querySelector('button.group-zoom'));
  }
  assert.deepEqual(
    Array.from(bodies[1].querySelectorAll('tr[data-objectid]')).map(
      (r) => r.dataset.objectid
    ),
    ['205', '301']
  );
  assert.equal(
    t.elements.summary.textContent,
    '3 pathways in 2 fire districts'
  );
  assert.equal(t.elements.notice.textContent, '');
});

test('a real district heading shows name, FDID, county, count and max rain', () => {
  const t = tableParts();
  t.render(LIVE_LIKE, OK_META);
  const toggle = t.headings()[1].querySelector('.group-toggle');
  assert.equal(
    toggle.querySelector('.group-name').textContent,
    'Asheville Fire Department'
  );
  assert.equal(
    toggle.querySelector('.group-meta').textContent,
    'FDID 11101 · Buncombe County · 2 pathways · max 5–6″'
  );
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(toggle.getAttribute('aria-label'), null, 'name comes from text');
  assert.doesNotMatch(toggle.textContent, /collapse|expand/i);
});

test('a district without FDID or county leaves those parts out', () => {
  const t = tableParts();
  t.render(
    [
      pathway(1, 'Haywood', 'A', 11, 1, {
        ...CRUSO,
        fdid: null,
        fd_county: null,
        fire_department: 'Maggie Valley FD',
      }),
    ],
    OK_META
  );
  assert.equal(
    t.doc.querySelector('.group-meta').textContent,
    '1 pathway · max 5–6″'
  );
});

test('No District and Outside North Carolina headings and their order', () => {
  const t = tableParts();
  t.render(
    [
      pathway(3, 'Cocke', 'C', 13, 1, OUTSIDE_NC),
      pathway(2, 'Swain', 'B', 12, 1, NO_DISTRICT),
      pathway(4, 'Swain', 'B', 11, 1, NO_DISTRICT),
      pathway(1, 'Buncombe', 'A', 11, 1, ASHEVILLE),
    ],
    OK_META
  );
  const names = t
    .headings()
    .map((th) => th.querySelector('.group-name').textContent);
  assert.deepEqual(names, [
    'Asheville Fire Department',
    'No District',
    'Outside North Carolina',
  ]);
  const metas = t
    .headings()
    .map((th) => th.querySelector('.group-meta').textContent);
  assert.equal(
    metas[1],
    "listed as No District in the state's fire district data · 2 pathways · max 6–8″"
  );
  assert.equal(metas[2], '1 pathway · max 8–10″');
  assert.ok(t.headings()[1].parentElement.classList.contains('is-special'));
  assert.ok(!t.headings()[0].parentElement.classList.contains('is-special'));
});

for (const [label, fires, want] of [
  [
    'districts only',
    [ASHEVILLE, ASHEVILLE, CRUSO],
    '3 pathways in 2 fire districts',
  ],
  ['one district', [ASHEVILLE], '1 pathway in 1 fire district'],
  [
    'both extras',
    [ASHEVILLE, CRUSO, CRUSO, NO_DISTRICT, NO_DISTRICT, OUTSIDE_NC],
    '6 pathways in 2 fire districts (2 with no district, 1 outside North Carolina)',
  ],
  [
    'no district only extra',
    [ASHEVILLE, NO_DISTRICT],
    '2 pathways in 1 fire district (1 with no district)',
  ],
  [
    'outside only extra',
    [ASHEVILLE, OUTSIDE_NC, OUTSIDE_NC],
    '3 pathways in 1 fire district (2 outside North Carolina)',
  ],
  [
    'no real district',
    [NO_DISTRICT, NO_DISTRICT, OUTSIDE_NC],
    '3 pathways (2 with no district, 1 outside North Carolina)',
  ],
]) {
  test('the grouped summary for ' + label, () => {
    const t = tableParts();
    t.render(
      fires.map((fire, i) => pathway(i + 1, 'Buncombe', 'A', 11, 1, fire)),
      OK_META
    );
    assert.equal(t.elements.summary.textContent, want);
  });
}

test('the grouped summary formats large counts with commas', () => {
  const t = tableParts();
  const many = [];
  for (let i = 0; i < 1200; i++) {
    many.push(pathway(i + 1, 'Buncombe', 'A', 11, 1, ASHEVILLE));
  }
  t.render(many, OK_META);
  assert.equal(
    t.elements.summary.textContent,
    '1,200 pathways in 1 fire district'
  );
});

test('the grouped caption explains the district headings', () => {
  const t = tableParts();
  t.render(LIVE_LIKE, OK_META);
  assert.match(
    t.elements.table.caption.textContent,
    /grouped by NC fire district.*Select a district heading/
  );
  t.render(LIVE_LIKE, {});
  assert.doesNotMatch(t.elements.table.caption.textContent, /district/);
});

test('the notice clears when districts become known', () => {
  const t = tableParts();
  t.render(LIVE_LIKE, {});
  assert.notEqual(t.elements.notice.textContent, '');
  t.render(LIVE_LIKE, OK_META);
  assert.equal(t.elements.notice.textContent, '');
});

test('collapsing a group hides only its pathway rows, and expanding shows them', () => {
  const t = tableParts();
  t.render(LIVE_LIKE, OK_META);
  const toggle = t.headings()[1].querySelector('.group-toggle');
  toggle.click();
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  const hidden = t
    .pathwayRows()
    .filter((r) => r.hidden)
    .map((r) => r.dataset.objectid);
  assert.deepEqual(hidden, ['205', '301']);
  assert.equal(t.headings()[1].parentElement.hidden, false, 'heading stays');
  toggle.click();
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(t.pathwayRows().filter((r) => r.hidden).length, 0);
});

test('a collapsed group stays collapsed when the table renders again', () => {
  const t = tableParts();
  t.render(LIVE_LIKE, OK_META);
  t.headings()[1].querySelector('.group-toggle').click();
  t.render(LIVE_LIKE, OK_META);
  const toggle = t.headings()[1].querySelector('.group-toggle');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.deepEqual(
    t
      .pathwayRows()
      .filter((r) => r.hidden)
      .map((r) => r.dataset.objectid),
    ['205', '301']
  );
});

test('"Show on map" names its group and zooms to the group pathways', () => {
  const t = tableParts();
  t.render(LIVE_LIKE, OK_META);
  const zoom = t.headings()[1].querySelector('.group-zoom');
  assert.equal(zoom.textContent, 'Show on map');
  assert.equal(
    zoom.getAttribute('aria-label'),
    'Show on map: Asheville Fire Department'
  );
  zoom.click();
  assert.deepEqual(t.zoomed, [[205, 301]]);
});

test('grouped rows still select by click, Enter and Space', () => {
  const t = tableParts();
  t.render(LIVE_LIKE, OK_META);
  const row = t.elements.table.querySelector('tr[data-objectid="102"]');
  row.click();
  row.dispatchEvent(new t.window.KeyboardEvent('keydown', { key: 'Enter' }));
  row.dispatchEvent(new t.window.KeyboardEvent('keydown', { key: ' ' }));
  assert.deepEqual(t.picked, [102, 102, 102]);
});

// ---- renderMessage --------------------------------------------------------
test('a message after a grouped render replaces every group body', () => {
  const t = tableParts();
  t.render(LIVE_LIKE, OK_META);
  assert.equal(t.bodies().length, 2);
  t.TABLE.renderMessage('Forecast data could not be loaded.', t.elements);
  assert.equal(t.bodies().length, 1);
  assert.equal(t.elements.table.querySelectorAll('.group-row').length, 0);
  const td = t.elements.table.querySelector('td');
  assert.equal(td.textContent, 'Forecast data could not be loaded.');
  assert.equal(td.colSpan, 5);
  assert.ok(td.classList.contains('empty-row'));
  assert.ok(!td.classList.contains('is-none'));
  assert.doesNotMatch(t.elements.table.caption.textContent, /district/);
});

test('a message after a plain render hides the notice', () => {
  const t = tableParts();
  t.render(LIVE_LIKE, {});
  t.TABLE.renderMessage('Forecast data could not be loaded.', t.elements);
  assert.equal(t.elements.notice.textContent, '');
});

// ---- toCSV ----------------------------------------------------------------
const META = {
  fire_districts: 'ok',
  window_start: '2026-10-27T18:00:00+00:00',
  window_end: '2026-10-28T18:00:00+00:00',
  issued: '2026-10-27T18:11:16+00:00',
};
const HEADER =
  'fdid,fire_department,fd_county,fd_address,district_updated,' +
  'county,watershed,forecast_rain,ndfd_category,area_acres,pathway_id,' +
  'window_start_utc,window_end_utc,nws_updated_utc,exported_utc,' +
  'fire_district_status';

// Splits one CSV line into its fields, keeping quoted fields whole.
function csvFields(line) {
  return line
    .match(/("([^"]|"")*"|[^,]*)(,|$)/g)
    .map((c) => c.replace(/,$/, ''))
    .slice(0, 16);
}

test('toCSV writes the header, one CRLF row per pathway and a trailing CRLF', () => {
  const csv = TABLE.toCSV(LIVE_LIKE, META);
  const lines = csv.split('\r\n');
  assert.equal(lines.pop(), '', 'ends with CRLF');
  assert.equal(lines[0], HEADER);
  assert.equal(lines.length, 4);
  assert.ok(!csv.includes('\n\n'));
});

test('toCSV rows follow the grouped order and end with the district status', () => {
  const features = [
    pathway(3, 'Cocke', 'C', 13, 1, OUTSIDE_NC),
    pathway(2, 'Swain', 'B', 12, 1, NO_DISTRICT),
    ...LIVE_LIKE,
  ];
  const lines = TABLE.toCSV(features, META).split('\r\n').slice(1, -1);
  const fields = lines.map(csvFields);
  assert.deepEqual(
    fields.map((f) => f[10]),
    ['102', '205', '301', '2', '3']
  );
  assert.deepEqual(
    fields.map((f) => f[15]),
    ['district', 'district', 'district', 'no_district', 'outside_nc']
  );
  const asheville = fields[1];
  assert.deepEqual(asheville.slice(0, 5), [
    '11101',
    'Asheville Fire Department',
    'Buncombe',
    '"100 Court Plaza, Asheville, NC 28801"',
    '2024-03-01',
  ]);
  assert.equal(asheville[11], META.window_start);
  assert.equal(asheville[12], META.window_end);
  assert.equal(asheville[13], META.issued);
  assert.match(asheville[14], /^\d{4}-\d{2}-\d{2}T.*Z$/);
});

test('toCSV marks every row "unavailable" and uses the plain sort when not known', () => {
  const features = [SWANNANOA, PIGEON, FRENCH_BROAD];
  const lines = TABLE.toCSV(features, { window_start: 'x' })
    .split('\r\n')
    .slice(1, -1);
  const fields = lines.map(csvFields);
  assert.deepEqual(
    fields.map((f) => f[10]),
    ['102', '205', '301']
  );
  assert.deepEqual(
    fields.map((f) => f[15]),
    ['unavailable', 'unavailable', 'unavailable']
  );
  assert.deepEqual(fields[0].slice(0, 5), ['', '', '', '', '']);
});

test('toCSV quotes fields with commas or quotes', () => {
  const quoted = pathway(
    7,
    'Say "Hi"',
    'Pigeon River, East Fork',
    12,
    3.75,
    {}
  );
  const fields = csvFields(TABLE.toCSV([quoted], {}).split('\r\n')[1]);
  assert.equal(fields[5], '"Say ""Hi"""');
  assert.equal(fields[6], '"Pigeon River, East Fork"');
  assert.equal(fields[7], '6–8″');
  assert.equal(fields[8], '12');
  assert.equal(fields[9], '3.8');
  assert.equal(fields[10], '7');
});

test('toCSV rounds acres to two places under one acre and one above', () => {
  const rows = TABLE.toCSV([SWANNANOA, FRENCH_BROAD], {}).split('\r\n');
  assert.equal(rows[1].split(',')[9], '12.0');
  assert.equal(rows[2].split(',')[9], '0.42');
});

test('toCSV leaves unknown values blank and non-numeric acres as dashes', () => {
  const bare = feature({ OBJECTID: 5, max_category: 99, area_acres: 'n/a' });
  const row = TABLE.toCSV([bare], undefined).split('\r\n')[1];
  const fields = row.split(',');
  assert.equal(fields.slice(0, 14).join(','), ',,,,,,,,99,--,5,,,');
  assert.equal(fields[15], 'unavailable');
});
