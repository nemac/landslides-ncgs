// app.js, driven through the page: the threshold filter, the status cards,
// the stale banner, the fire district table modes and notice, the error
// state, overlapping loads, the layer toggles, the table tab and the CSV
// download. The clock is fixed at FIXED_NOW (2:40 PM ET on
// 2026-10-27, during daylight time); the live fixture's status.json was
// checked two minutes earlier.
const { test, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const {
  loadPage,
  fixture,
  errorResponse,
  deferred,
  FIXED_NOW,
} = require('./load-page');

const MINUTE = 60000;
let page = null;

beforeEach(() => {
  mock.timers.enable({
    apis: ['Date', 'setTimeout', 'setInterval'],
    now: FIXED_NOW,
  });
});

afterEach(() => {
  if (page) page.close();
  page = null;
  mock.timers.reset();
});

async function open(options) {
  page = loadPage(options);
  await page.settle();
  return page;
}

function isoMinutesBefore(minutes) {
  return new Date(FIXED_NOW - minutes * MINUTE).toISOString();
}

function rowIds(p) {
  return Array.from(
    p.$('alerts-table').querySelectorAll('tr[data-objectid]')
  ).map((tr) => tr.dataset.objectid);
}

function groupNames(p) {
  return Array.from(
    p.$('alerts-table').querySelectorAll('.group-row .group-name')
  ).map((el) => el.textContent);
}

const NOTICE_TEXT =
  'Fire district information is unavailable right now. ' +
  'Pathways are listed without districts.';

// ---- First load ------------------------------------------------------------
test('the live fixture renders three flagged pathways, grouped, above the threshold', async () => {
  const p = await open();
  assert.equal(p.$('status-count').textContent, '3');
  assert.ok(p.$('status-card').classList.contains('has-alerts'));
  assert.ok(!p.$('status-card').classList.contains('is-zero'));
  assert.deepEqual(
    rowIds(p),
    ['102', '205', '301'],
    'pathway 407 is category 10'
  );
  assert.deepEqual(groupNames(p), [
    'Cruso Fire Department',
    'Asheville Fire Department',
  ]);
  assert.equal(p.$('alerts-table').tBodies.length, 2);
  assert.equal(
    p.$('table-summary').textContent,
    '3 pathways in 2 fire districts'
  );
  assert.equal(p.$('district-notice').textContent, '');
  assert.equal(p.$('export-csv').disabled, false);
  assert.equal(p.$('loading-indicator').hidden, true);
  assert.equal(p.$('loading-indicator').getAttribute('aria-busy'), 'false');
  assert.equal(p.$('stale-banner').hidden, true);
});

test('a file from the older pipeline is listed plainly with the notice', async () => {
  const p = await open({ data: fixture('stale') });
  assert.deepEqual(rowIds(p), ['102', '205', '301']);
  assert.deepEqual(groupNames(p), []);
  assert.equal(p.$('alerts-table').tBodies.length, 1);
  assert.equal(p.$('table-summary').textContent, '3 pathways in 2 counties');
  assert.equal(p.$('district-notice').textContent, NOTICE_TEXT);
  assert.equal(p.$('district-notice').getAttribute('role'), 'status');
  const alerts = p.mapCalls('setAlerts');
  assert.equal(alerts[0][2], false, 'the map popups must not name districts');
  assert.doesNotMatch(p.$('alerts-table').caption.textContent, /fire district/);
});

test('a failed district lookup is listed plainly with the notice', async () => {
  const data = fixture('live');
  data.flagged.meta.fire_districts = 'unavailable';
  const p = await open({ data });
  assert.deepEqual(groupNames(p), []);
  assert.equal(p.$('district-notice').textContent, NOTICE_TEXT);
});

test('the grouped caption mentions the fire district headings', async () => {
  const p = await open();
  assert.match(
    p.$('alerts-table').caption.textContent,
    /grouped by NC fire district/
  );
});

test('the first load hands the map the window and the flagged pathways', async () => {
  const p = await open();
  const period = p.mapCalls('setForecastPeriod');
  assert.equal(period.length, 1);
  assert.equal(period[0][1].window_end, '2026-10-28T18:00:00+00:00');
  const alerts = p.mapCalls('setAlerts');
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0][2], true, 'districts are known in this file');
  assert.deepEqual(
    alerts[0][1].features.map((f) => f.properties.OBJECTID),
    [102, 205, 301]
  );
  assert.deepEqual(p.mapCalls('setAlertsVisible'), [
    ['setAlertsVisible', true],
  ]);
  assert.equal(p.mapCalls('refreshObserved').length, 1);
  assert.equal(p.mapCalls('init').length, 1);
});

test('the threshold filter keeps string categories and drops lower ones', async () => {
  const data = fixture('live');
  data.flagged.features[0].properties.max_category = '11';
  data.flagged.features[2].properties.max_category = 10.9;
  const p = await open({ data });
  assert.deepEqual(rowIds(p), ['102', '301']);
});

test('the status cards show the window in ET and UTC and the check times', async () => {
  const p = await open();
  assert.equal(
    p.$('status-window').textContent,
    'Tue, Oct 27, 2:00 PM ET – Wed, Oct 28, 2:00 PM ET'
  );
  assert.equal(
    p.$('status-window-note').textContent,
    'Oct 27, 18:00 UTC – Oct 28, 18:00 UTC'
  );
  assert.equal(p.$('status-issued').textContent, '2:11 PM ET');
  assert.equal(
    p.$('status-checked').textContent,
    'Last checked for updates 2:38 PM ET'
  );
  assert.equal(p.$('status-next').textContent, 'Next update check in 8 min');
  assert.ok(!p.$('status-next').classList.contains('is-checking'));
  assert.equal(p.$('check-interval-text').textContent, '10');
});

test('an issued time on another day shows its date', async () => {
  const data = fixture('live');
  data.flagged.meta.issued = '2026-10-26T20:30:00+00:00';
  const p = await open({ data });
  assert.equal(p.$('status-issued').textContent, 'Mon, Oct 26, 4:30 PM ET');
});

test('the empty fixture renders the none-flagged state', async () => {
  const p = await open({ data: fixture('empty') });
  assert.equal(p.$('status-count').textContent, '0');
  assert.ok(p.$('status-card').classList.contains('is-zero'));
  assert.ok(!p.$('status-card').classList.contains('has-alerts'));
  assert.equal(p.$('table-summary').textContent, 'None flagged');
  assert.equal(p.$('district-notice').textContent, '');
  assert.equal(p.$('export-csv').disabled, true);
  assert.deepEqual(p.mapCalls('setAlerts')[0][1].features, []);
});

test('the page wiring: source link, legend, MRMS ramp and refresh table', async () => {
  const p = await open();
  assert.match(
    p.$('source-link').href,
    /NDFD_Precipitation_v1\/FeatureServer\/1$/
  );

  const items = Array.from(p.$('ndfd-legend-list').querySelectorAll('li'));
  assert.equal(items.length, 20);
  assert.equal(
    items.filter((li) => li.classList.contains('at-threshold')).length,
    9
  );
  assert.ok(!items[10].classList.contains('at-threshold'));
  assert.ok(items[11].classList.contains('at-threshold'));
  assert.equal(items[11].textContent, '5–6″');
  assert.equal(
    items[11].querySelector('.legend-swatch').style.background,
    'rgb(245, 158, 11)'
  );

  assert.match(
    p.$('mrms-ramp-bar').style.background,
    /^linear-gradient\(to right, rgb\(0, 12, 255\) 0%/
  );
  assert.equal(
    p.$('mrms-ramp-ticks').querySelectorAll('.ramp-tick').length,
    11
  );

  // Daylight time on 2026-10-27: 00/06/12/18 UTC are 8 PM, 2 AM, 8 AM, 2 PM.
  assert.equal(
    p.$('window-step-times').textContent,
    '2 AM, 8 AM, 2 PM, 8 PM ET'
  );
});

test('the refresh table shows standard-time hours in winter', async () => {
  mock.timers.setTime(Date.parse('2026-12-15T15:00:00Z'));
  const p = await open();
  assert.equal(
    p.$('window-step-times').textContent,
    '1 AM, 7 AM, 1 PM, 7 PM ET'
  );
});

// ---- Window and freshness wording -----------------------------------------
test('a file without window bounds gets the generic wording', async () => {
  const data = fixture('live');
  delete data.flagged.meta.window_start;
  const p = await open({ data });
  assert.equal(p.$('status-window').textContent, 'About the next 24 hours');
  assert.equal(
    p.$('status-window-note').textContent,
    'Exact start and end times are not in this data file.'
  );
});

test('a window that has ended says so in the note and the banner', async () => {
  const data = fixture('live');
  data.flagged.meta.window_start = '2026-10-26T12:00:00+00:00';
  data.flagged.meta.window_end = '2026-10-27T12:00:00+00:00';
  const p = await open({ data });
  assert.match(
    p.$('status-window-note').textContent,
    /\. This period has ended\.$/
  );
  assert.equal(p.$('stale-banner').hidden, false);
  assert.equal(
    p.$('stale-banner').textContent,
    'The forecast period shown has already ended.'
  );
});

test('the stale fixture (checked two hours ago) shows the banner in hours', async () => {
  const p = await open({ data: fixture('stale') });
  assert.equal(p.$('stale-banner').hidden, false);
  assert.match(
    p.$('stale-banner').textContent,
    /^This page has not been able to check for a new forecast in 2 hours\. /
  );
  assert.equal(p.$('status-count').textContent, '3', 'data still shown');
});

for (const [minutes, wording] of [
  [44, null],
  [46, '46 minutes'],
  [89, '89 minutes'],
  [90, '2 hours'],
  [47 * 60, '47 hours'],
  [49 * 60, '2 days'],
]) {
  test(
    'a check ' + minutes + ' minutes ago reads as ' + (wording || 'fresh'),
    async () => {
      const data = fixture('live');
      data.status.checked_at = isoMinutesBefore(minutes);
      const p = await open({ data });
      if (wording === null) {
        assert.equal(p.$('stale-banner').hidden, true);
      } else {
        assert.equal(p.$('stale-banner').hidden, false);
        assert.ok(
          p.$('stale-banner').textContent.includes(' in ' + wording + '.')
        );
      }
    }
  );
}

test('no check time and no build time means the age is unknown', async () => {
  const data = fixture('live');
  data.status = errorResponse(500);
  delete data.flagged.meta.generated_at;
  const p = await open({ data });
  assert.equal(p.$('stale-banner').hidden, false);
  assert.match(
    p.$('stale-banner').textContent,
    /^The age of this data is unknown\./
  );
  assert.equal(p.$('status-checked').textContent, '');
  assert.equal(
    p.$('status-next').textContent,
    'Checks for updates every 10 min'
  );
});

test('a missing status file falls back to when the data file was built', async () => {
  const data = fixture('live');
  data.status = errorResponse(404);
  const p = await open({ data });
  assert.equal(p.$('status-count').textContent, '3');
  assert.equal(
    p.$('status-checked').textContent,
    'Last checked for updates 2:20 PM ET'
  );
  // Built at 2:20 PM plus the 10-minute default is already past 2:40 PM.
  assert.equal(
    p.$('status-next').textContent,
    'Checking for updates now\u2026'
  );
});

test('the check interval from status.json drives the wording', async () => {
  const data = fixture('live');
  data.status.check_interval_minutes = 30;
  const p = await open({ data });
  assert.equal(p.$('check-interval-text').textContent, '30');
  assert.equal(p.$('status-next').textContent, 'Next update check in 28 min');
});

test('a zero or missing check interval falls back to 10 minutes', async () => {
  const data = fixture('live');
  data.status.check_interval_minutes = 0;
  const p = await open({ data });
  assert.equal(p.$('check-interval-text').textContent, '10');
});

test('an overdue check reads as checking now', async () => {
  const data = fixture('live');
  data.status.checked_at = isoMinutesBefore(15);
  const p = await open({ data });
  assert.equal(p.$('status-next').textContent, 'Checking for updates now…');
  assert.ok(p.$('status-next').classList.contains('is-checking'));
});

test('the next-check countdown ticks down on the 30-second timer', async () => {
  const p = await open();
  assert.equal(p.$('status-next').textContent, 'Next update check in 8 min');
  mock.timers.tick(3 * MINUTE);
  assert.equal(p.$('status-next').textContent, 'Next update check in 5 min');
});

// ---- Error state ----------------------------------------------------------
async function expectErrorState(p) {
  assert.equal(p.$('status-count').textContent, '--');
  assert.equal(p.$('status-window').textContent, 'Unavailable');
  assert.equal(p.$('status-window-note').textContent, '');
  assert.equal(p.$('status-next').textContent, '');
  assert.equal(p.$('stale-banner').hidden, false);
  assert.match(
    p.$('stale-banner').textContent,
    /^Forecast data could not be loaded\./
  );
  assert.equal(p.$('table-summary').textContent, 'Data unavailable');
  const bodies = p.$('alerts-table').tBodies;
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].textContent, 'Forecast data could not be loaded.');
  assert.equal(p.$('alerts-table').querySelectorAll('.group-row').length, 0);
  assert.equal(p.$('district-notice').textContent, '');
  assert.equal(p.$('export-csv').disabled, true);
  assert.equal(p.$('loading-indicator').hidden, true);
  const alerts = p.mapCalls('setAlerts');
  assert.deepEqual(alerts[alerts.length - 1], ['setAlerts', null]);
}

test('a missing flagged file puts the page in the error state', async () => {
  const data = fixture('live');
  data.flagged = errorResponse(404);
  const p = await open({ data });
  await expectErrorState(p);
  assert.ok(p.consoleLines.some((l) => l[0] === 'error'));
});

test('a flagged file that is not GeoJSON puts the page in the error state', async () => {
  const data = fixture('live');
  data.flagged = { type: 'Feature', properties: {} };
  const p = await open({ data });
  await expectErrorState(p);
});

test('a failed reload clears the pathways a good load had drawn', async () => {
  let fail = false;
  const live = fixture('live');
  const data = {
    ...live,
    flagged: () => (fail ? errorResponse(503) : live.flagged),
  };
  const p = await open({ data });
  assert.equal(p.$('status-count').textContent, '3');
  assert.equal(groupNames(p).length, 2, 'grouped before the failure');
  fail = true;
  p.document.dispatchEvent(new p.window.Event('visibilitychange'));
  await p.settle();
  await expectErrorState(p);
});

test('a failed reload after a plain list also clears the notice', async () => {
  let fail = false;
  const stale = fixture('stale');
  const data = {
    ...stale,
    flagged: () => (fail ? errorResponse(503) : stale.flagged),
  };
  const p = await open({ data });
  assert.equal(p.$('district-notice').textContent, NOTICE_TEXT);
  fail = true;
  p.document.dispatchEvent(new p.window.Event('visibilitychange'));
  await p.settle();
  assert.equal(p.$('district-notice').textContent, '');
  assert.equal(p.$('alerts-table').tBodies.length, 1);
});

test('a good load after an error brings the groups back', async () => {
  let fail = true;
  const live = fixture('live');
  const data = {
    ...live,
    flagged: () => (fail ? errorResponse(503) : live.flagged),
  };
  const p = await open({ data });
  assert.equal(p.$('table-summary').textContent, 'Data unavailable');
  fail = false;
  p.document.dispatchEvent(new p.window.Event('visibilitychange'));
  await p.settle();
  assert.equal(groupNames(p).length, 2);
  assert.equal(p.$('alerts-table').tBodies.length, 2);
});

// ---- Overlapping loads ----------------------------------------------------
// ---- Reloads that bring the same pathways ------------------------------------
async function reload(p) {
  p.document.dispatchEvent(new p.window.Event('visibilitychange'));
  await p.settle();
}

test('a reload with the same pathways leaves the table, the map and focus alone', async () => {
  const live = fixture('live');
  let checkedMinutesAgo = 2;
  const data = {
    ...live,
    status: () => ({
      ...live.status,
      checked_at: isoMinutesBefore(checkedMinutesAgo),
    }),
  };
  const p = await open({ data });
  const row = p.$('alerts-table').querySelector('tr[data-objectid="205"]');
  row.focus();
  const nextBefore = p.$('status-next').textContent;

  checkedMinutesAgo = 0;
  await reload(p);
  assert.equal(
    p.$('alerts-table').querySelector('tr[data-objectid="205"]'),
    row,
    'the row was not rebuilt'
  );
  assert.equal(p.document.activeElement, row);
  assert.equal(p.mapCalls('setAlerts').length, 1, 'the map layer was kept');
  assert.notEqual(
    p.$('status-next').textContent,
    nextBefore,
    'the status card still shows the newer check'
  );
});

test('a reload with different pathways redraws the table and the map', async () => {
  const live = fixture('live');
  let dropOne = false;
  const data = {
    ...live,
    flagged: () => {
      if (!dropOne) return live.flagged;
      const features = live.flagged.features.filter(
        (f) => f.properties.OBJECTID !== 301
      );
      return { ...live.flagged, features };
    },
  };
  const p = await open({ data });
  p.$('alerts-table').querySelector('tr[data-objectid="205"]').focus();
  dropOne = true;
  await reload(p);
  assert.deepEqual(rowIds(p), ['102', '205']);
  assert.equal(p.mapCalls('setAlerts').length, 2);
  assert.equal(p.document.activeElement.dataset.objectid, '205');
});

test('a change in the fire district marker alone redraws the table', async () => {
  const live = fixture('live');
  let lookupFailed = false;
  const data = {
    ...live,
    flagged: () => {
      if (!lookupFailed) return live.flagged;
      const meta = { ...live.flagged.meta, fire_districts: 'unavailable' };
      return { ...live.flagged, meta };
    },
  };
  const p = await open({ data });
  assert.equal(groupNames(p).length, 2);
  lookupFailed = true;
  await reload(p);
  assert.deepEqual(groupNames(p), []);
  assert.equal(p.$('district-notice').textContent, NOTICE_TEXT);
});

test('the same pathways are drawn again after an error', async () => {
  let fail = false;
  const live = fixture('live');
  const data = {
    ...live,
    flagged: () => (fail ? errorResponse(503) : live.flagged),
  };
  const p = await open({ data });
  fail = true;
  await reload(p);
  assert.deepEqual(rowIds(p), []);
  fail = false;
  await reload(p);
  assert.deepEqual(rowIds(p), ['102', '205', '301']);
});

test('an older response cannot overwrite a newer load', async () => {
  const live = fixture('live');
  const empty = fixture('empty');
  const first = deferred();
  let n = 0;
  const data = {
    ...live,
    flagged: () => (++n === 1 ? first.promise : empty.flagged),
  };
  const p = await open({ data });
  assert.equal(p.$('status-count').textContent, '--', 'first load pending');

  p.document.dispatchEvent(new p.window.Event('visibilitychange'));
  await p.settle();
  assert.equal(p.$('status-count').textContent, '0', 'second load won');

  first.resolve(live.flagged);
  await p.settle();
  assert.equal(p.$('status-count').textContent, '0');
  assert.deepEqual(rowIds(p), []);
  assert.equal(p.mapCalls('setAlerts').length, 1, 'stale load dropped');
  assert.equal(p.$('loading-indicator').hidden, true);
});

test('a hidden tab does not reload on visibilitychange', async () => {
  const p = await open();
  const before = p.fetchCalls.length;
  Object.defineProperty(p.document, 'hidden', {
    value: true,
    configurable: true,
  });
  p.document.dispatchEvent(new p.window.Event('visibilitychange'));
  await p.settle();
  assert.equal(p.fetchCalls.length, before);
});

// ---- Timers ---------------------------------------------------------------
test('a reload is scheduled a minute after the next pipeline check', async () => {
  const data = fixture('live');
  data.status.checked_at = isoMinutesBefore(7); // due at +3 min, reload at +4
  const p = await open({ data });
  const before = p.fetchCalls.length;
  mock.timers.tick(4 * MINUTE - 1);
  assert.equal(p.fetchCalls.length, before);
  mock.timers.tick(1);
  await p.settle();
  assert.equal(p.fetchCalls.length, before + 3);
});

test('no early reload when the next check is beyond the five-minute poll', async () => {
  const p = await open(); // due at +8 min, reload would be +9
  const before = p.fetchCalls.length;
  mock.timers.tick(5 * MINUTE - 1);
  assert.equal(p.fetchCalls.length, before);
  mock.timers.tick(1);
  await p.settle();
  assert.equal(p.fetchCalls.length, before + 3, 'the regular poll');
});

// ---- Layer toggles and zoom gating ---------------------------------------
test('each layer checkbox calls the matching map method with its state', async () => {
  const p = await open();
  const pairs = [
    ['layer-ndfd', 'setForecastVisible'],
    ['layer-mrms', 'setObservedVisible'],
    ['layer-radar', 'setRadarVisible'],
    ['layer-alerts', 'setAlertsVisible'],
    ['layer-fire', 'setFireDistrictsVisible'],
    ['layer-parcels', 'setParcelsVisible'],
    ['layer-buildings', 'setBuildingsVisible'],
  ];
  for (const [id, method] of pairs) {
    const box = p.$(id);
    const want = !box.checked;
    box.checked = want;
    box.dispatchEvent(new p.window.Event('change'));
    const calls = p.mapCalls(method);
    assert.deepEqual(calls[calls.length - 1], [method, want], id);
  }
});

test('the reference layer shows the spinner until the map reports it loaded', async () => {
  const p = await open();
  const box = p.$('layer-reference');
  box.checked = true;
  box.dispatchEvent(new p.window.Event('change'));
  assert.deepEqual(p.mapCalls('setReferenceVisible'), [
    ['setReferenceVisible', true],
  ]);
  assert.equal(p.$('loading-indicator').hidden, false);
  p.MAP.reference.resolve();
  await p.settle();
  assert.equal(p.$('loading-indicator').hidden, true);

  box.checked = false;
  box.dispatchEvent(new p.window.Event('change'));
  await p.settle();
  assert.equal(p.$('loading-indicator').hidden, true);
});

test('parcels and buildings rows grey out below their zoom levels', async () => {
  const p = await open();
  assert.ok(p.$('row-parcels').classList.contains('below-zoom'));
  assert.ok(p.$('row-buildings').classList.contains('below-zoom'));
  p.MAP.map.zoom = 12;
  p.MAP.map.fire('zoomend');
  assert.ok(p.$('row-parcels').classList.contains('below-zoom'));
  assert.ok(!p.$('row-buildings').classList.contains('below-zoom'));
  p.MAP.map.zoom = 14;
  p.MAP.map.fire('zoomend');
  assert.ok(!p.$('row-parcels').classList.contains('below-zoom'));
});

test('selecting a table row zooms the map to that pathway', async () => {
  const p = await open();
  p.$('alerts-table').querySelector('tr[data-objectid="205"]').click();
  assert.deepEqual(p.mapCalls('zoomToAlert'), [['zoomToAlert', 205]]);
});

test('"Show on map" turns a hidden pathways layer back on and ticks its box', async () => {
  const p = await open();
  p.$('layer-alerts').click();
  assert.equal(p.$('layer-alerts').checked, false);
  p.$('alerts-table').tBodies[1].querySelector('.group-zoom').click();
  assert.equal(p.$('layer-alerts').checked, true);
  const calls = p.mapCalls('setAlertsVisible');
  assert.deepEqual(calls[calls.length - 1], ['setAlertsVisible', true]);
  assert.equal(p.mapCalls('zoomToAlerts').length, 1);
});

test('selecting a row turns a hidden pathways layer back on too', async () => {
  const p = await open();
  p.$('layer-alerts').click();
  p.$('alerts-table').querySelector('tr[data-objectid="205"]').click();
  assert.equal(p.$('layer-alerts').checked, true);
});

test('zooming leaves the pathways layer alone when it is already shown', async () => {
  const p = await open();
  const before = p.mapCalls('setAlertsVisible').length;
  p.$('alerts-table').querySelector('tr[data-objectid="205"]').click();
  assert.equal(p.mapCalls('setAlertsVisible').length, before);
});

test('"Show on map" zooms the map to every pathway in that district', async () => {
  const p = await open();
  const zoom = p.$('alerts-table').tBodies[1].querySelector('.group-zoom');
  zoom.click();
  const calls = p.mapCalls('zoomToAlerts');
  assert.equal(calls.length, 1);
  assert.deepEqual(Array.from(calls[0][1]), [205, 301]);
});

test('a collapsed district stays collapsed across the automatic reload', async () => {
  const p = await open();
  const toggle = () =>
    p.$('alerts-table').tBodies[1].querySelector('.group-toggle');
  toggle().click();
  mock.timers.tick(5 * MINUTE);
  await p.settle();
  assert.equal(toggle().getAttribute('aria-expanded'), 'false');
  assert.deepEqual(
    Array.from(p.$('alerts-table').querySelectorAll('tr[hidden]')).map(
      (tr) => tr.dataset.objectid
    ),
    ['205', '301']
  );
});

// ---- Table tab ------------------------------------------------------------
test('the table tab hides and shows the table and saves the choice', async () => {
  const p = await open();
  mock.timers.tick(50); // the resize queued when the page set up the tab
  const tab = p.$('toggle-table');
  assert.equal(tab.getAttribute('aria-expanded'), 'true');
  assert.equal(tab.getAttribute('aria-label'), 'Hide table');
  assert.equal(p.$('table-wrapper').hidden, false);

  tab.click();
  assert.equal(tab.getAttribute('aria-expanded'), 'false');
  assert.equal(tab.getAttribute('aria-label'), 'Show table');
  assert.equal(tab.title, 'Show table');
  assert.equal(p.$('table-wrapper').hidden, true);
  assert.ok(
    p.document
      .querySelector('.table-section')
      .classList.contains('is-collapsed')
  );
  assert.equal(p.window.localStorage.getItem('siren.tableOpen'), '0');

  const resizesBefore = p.MAP.calls.filter((c) => c[0] === 'invalidateSize');
  mock.timers.tick(50);
  const resizesAfter = p.MAP.calls.filter((c) => c[0] === 'invalidateSize');
  assert.equal(resizesAfter.length, resizesBefore.length + 1, 'map resized');

  tab.click();
  assert.equal(p.$('table-wrapper').hidden, false);
  assert.equal(p.window.localStorage.getItem('siren.tableOpen'), '1');
});

test('a saved hidden table starts hidden', async () => {
  const p = await open({ storage: { 'siren.tableOpen': '0' } });
  assert.equal(p.$('toggle-table').getAttribute('aria-expanded'), 'false');
  assert.equal(p.$('table-wrapper').hidden, true);
});

// ---- CSV download ---------------------------------------------------------
test('the download button saves a CSV named for the fixed view and the time', async () => {
  const p = await open();
  p.$('export-csv').click();
  assert.equal(p.downloads.length, 1);
  assert.equal(
    p.downloads[0].download,
    'dfens-flagged-24h-5in-2026-10-27T18-40-00Z.csv'
  );
  assert.equal(p.downloads[0].href, 'blob:fake/1');
  assert.equal(p.blobs[0].type, 'text/csv;charset=utf-8');
  const text = await p.blobs[0].text();
  const lines = text.split('\r\n');
  assert.equal(lines.length, 5, 'header, three rows, trailing newline');
  assert.match(lines[0], /^pathway_id,county,.*,exported_utc$/);
  assert.match(
    lines[1],
    /^102,Haywood,"Pigeon River, East Fork",6–8″,12,3\.8,district,Cruso Fire Department,44104,Haywood,"13 Cruso Rd, Canton, NC 28716",2023-07-15,2026-10-27T18:00:00\+00:00,/
  );
  assert.match(lines[2], /^205,.*,district,Asheville Fire Department,/);
});

test('the CSV from an older file marks the district status unavailable', async () => {
  const p = await open({ data: fixture('stale') });
  p.$('export-csv').click();
  const lines = (await p.blobs[0].text()).split('\r\n');
  assert.match(
    lines[1],
    /^102,Haywood,"Pigeon River, East Fork",.*,unavailable,,,,,,2026-/
  );
});

test('the download button does nothing when nothing is flagged', async () => {
  const p = await open({ data: fixture('empty') });
  p.$('export-csv').click();
  assert.equal(p.downloads.length, 0);
});
