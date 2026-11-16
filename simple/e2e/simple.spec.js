// The real page in a real browser: scripts load in order, Leaflet draws the
// flagged pathways, the table and map agree, the toggles work, the CSV
// downloads, and axe finds no WCAG A or AA problems. Data comes from
// simple/test/fixtures/ through ?data=: `live` has fire districts, `stale`
// is an older file without them. unpkg stays reachable because it serves
// Leaflet and esri-leaflet; every other host (basemap tiles, NDFD, NCGS,
// parcels, fonts) is blocked, and the blocked NDFD layer proves the map
// notice. The clock is fixed to match the fixtures.
const { test, expect } = require('@playwright/test');
const { default: AxeBuilder } = require('@axe-core/playwright');

const FIXED_NOW = new Date('2026-10-27T18:40:00Z');
const ALLOWED_HOSTS = new Set(['127.0.0.1', 'unpkg.com']);
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const NOTICE_TEXT =
  'Fire district information is unavailable right now. ' +
  'Pathways are listed without districts.';

function pageUrl(fixtureFolder) {
  return '/simple/?data=/simple/test/fixtures/' + fixtureFolder + '/';
}

test.beforeEach(async ({ page }) => {
  await page.route('**/*', (route) => {
    const host = new URL(route.request().url()).hostname;
    return ALLOWED_HOSTS.has(host) ? route.continue() : route.abort();
  });
  await page.clock.setFixedTime(FIXED_NOW);
});

// Page-level errors and failed same-origin requests fail the test.
function watch(page) {
  const errors = [];
  const badResponses = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  page.on('console', (msg) => {
    // Requests to the blocked hosts log "Failed to load resource"; those
    // are expected. Anything else at error level is not.
    if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) {
      errors.push(msg.text());
    }
  });
  page.on('response', (resp) => {
    const url = new URL(resp.url());
    if (url.hostname === '127.0.0.1' && resp.status() !== 200) {
      badResponses.push(resp.status() + ' ' + url.pathname);
    }
  });
  return { errors, badResponses };
}

async function openLive(page) {
  const log = watch(page);
  await page.goto(pageUrl('live'));
  await expect(page.locator('#status-count')).toHaveText('3');
  return log;
}

async function openStale(page) {
  await page.goto(pageUrl('stale'));
  await expect(page.locator('#status-count')).toHaveText('3');
}

function groupToggle(page, name) {
  return page.locator('.group-toggle', { hasText: name });
}

function mapZoom(page) {
  return page.evaluate(() => window.DFS_MAP._internalMap().getZoom());
}

async function readDownload(download) {
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function expectNoAxeViolations(page) {
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  const summary = results.violations.map(
    (v) => v.id + ': ' + v.nodes.map((n) => n.target.join(' ')).join(' | ')
  );
  expect(summary).toEqual([]);
}

// ---- Districts known (the live fixture) -----------------------------------
test('the live fixture renders the cards, the grouped table and the map', async ({
  page,
}) => {
  const log = await openLive(page);

  await expect(page.locator('#status-card')).toHaveClass(/has-alerts/);
  await expect(page.locator('#status-window')).toHaveText(
    'Tue, Oct 27, 2:00 PM ET – Wed, Oct 28, 2:00 PM ET'
  );
  await expect(page.locator('#status-issued')).toHaveText('2:11 PM ET');
  await expect(page.locator('#status-next')).toHaveText(
    'Next update check in 8 min'
  );
  await expect(page.locator('#stale-banner')).toBeHidden();
  await expect(page.locator('#table-summary')).toHaveText(
    '3 pathways in 2 fire districts'
  );
  await expect(page.locator('.district-notice')).toHaveCount(0);

  await expect(page.locator('#alerts-table tbody')).toHaveCount(2);
  await expect(page.locator('.group-row .group-name')).toHaveText([
    'Cruso Fire Department',
    'Asheville Fire Department',
  ]);
  await expect(page.locator('.group-row .group-meta').nth(1)).toHaveText(
    'FDID 11101 · Buncombe County · 2 pathways · max 5–6″'
  );
  await expect(
    page.getByRole('rowheader', { name: /Asheville Fire Department/ })
  ).toHaveCount(1);

  const rows = page.locator('#alerts-table tr[data-objectid]');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText('Haywood');
  await expect(rows.nth(0)).toContainText('6–8″');
  await expect(page.locator('#alerts-table')).not.toContainText('407');

  // Leaflet drew one polygon per flagged pathway in the alerts pane.
  await expect(page.locator('.leaflet-alerts-pane path')).toHaveCount(3);
  await expect(page.locator('.leaflet-control-layers')).toBeVisible();
  await expect(page.locator('.geocoder-control input')).toBeVisible();

  // The NDFD service is blocked, so the page must say the layer failed.
  await expect(page.locator('.map-notice')).toContainText(
    'could not be loaded from the NWS service'
  );

  await expect(page.locator('#loading-indicator')).toBeHidden();
  expect(log.badResponses).toEqual([]);
  expect(log.errors).toEqual([]);
});

test('a district collapses and expands with the mouse', async ({ page }) => {
  await openLive(page);
  const toggle = groupToggle(page, 'Asheville Fire Department');
  const rows = page.locator(
    '#alerts-table tr[data-objectid="205"], #alerts-table tr[data-objectid="301"]'
  );
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toBeHidden();
  await expect(rows.nth(1)).toBeHidden();
  await expect(page.locator('tr[data-objectid="102"]')).toBeVisible();
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(rows.nth(0)).toBeVisible();
});

test('a district collapses and expands from the keyboard', async ({ page }) => {
  await openLive(page);
  const toggle = groupToggle(page, 'Cruso Fire Department');
  await toggle.focus();
  await page.keyboard.press('Enter');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('tr[data-objectid="102"]')).toBeHidden();
  await expect(toggle).toBeFocused();
  await page.keyboard.press('Space');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('tr[data-objectid="102"]')).toBeVisible();

  // Tab moves on to the district's "Show on map" button, then its rows.
  await page.keyboard.press('Tab');
  await expect(
    page.getByRole('button', { name: 'Show on map: Cruso Fire Department' })
  ).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.locator('tr[data-objectid="102"]')).toBeFocused();
});

test('"Show on map" fits the map to the district pathways', async ({
  page,
}) => {
  await openLive(page);
  const zoomBefore = await mapZoom(page);
  await page
    .getByRole('button', { name: 'Show on map: Asheville Fire Department' })
    .click();
  await expect.poll(() => mapZoom(page)).toBeGreaterThan(zoomBefore);
  await expect(page.locator('.leaflet-popup')).toHaveCount(0);
});

// The box Leaflet zooms to for each drawn pathway, keyed by pathway ID.
function pathwayBoxes(page) {
  return page.evaluate(() => {
    const boxes = {};
    window.DFS_MAP._internalMap().eachLayer((layer) => {
      if (!layer.feature || !layer.getBounds) return;
      boxes[layer.feature.properties.OBJECTID] = layer
        .getBounds()
        .toBBoxString();
    });
    return boxes;
  });
}

test('"Show on map" leaves each pathway its own zoom box', async ({ page }) => {
  // Real Leaflet hands out a pathway's stored box itself, not a copy. If
  // the district zoom grew that box, selecting the pathway afterwards
  // would show the whole district. The unit tests use a stand-in for
  // Leaflet, so this is checked here against the real library.
  await openLive(page);
  const before = await pathwayBoxes(page);
  expect(Object.keys(before).sort()).toEqual(['102', '205', '301']);
  expect(before['205']).not.toBe(before['301']);

  const zoomBefore = await mapZoom(page);
  await page
    .getByRole('button', { name: 'Show on map: Asheville Fire Department' })
    .click();
  await expect.poll(() => mapZoom(page)).toBeGreaterThan(zoomBefore);

  expect(await pathwayBoxes(page)).toEqual(before);
});

test('selecting a row zooms the map to that pathway and opens its popup', async ({
  page,
}) => {
  await openLive(page);
  const zoomBefore = await mapZoom(page);
  await page.locator('#alerts-table tr[data-objectid="205"]').click();
  const popup = page.locator('.leaflet-popup .alert-popup');
  await expect(popup).toContainText('Flagged pathway 205');
  await expect(popup).toContainText('French Broad River');
  await expect(popup).toContainText('Asheville Fire Department (FDID 11101)');
  await expect.poll(() => mapZoom(page)).toBeGreaterThan(zoomBefore);
});

test('a reload with the same pathways keeps the popup open and the row focused', async ({
  page,
}) => {
  await openLive(page);
  const row = page.locator('#alerts-table tr[data-objectid="205"]');
  await row.focus();
  await page.keyboard.press('Enter');
  const popup = page.locator('.leaflet-popup .alert-popup');
  await expect(popup).toContainText('Flagged pathway 205');

  // The page reloads its data when the tab becomes visible again.
  const reloaded = page.waitForResponse((response) =>
    response.url().includes('flagged_ndfd_24h_min11.geojson')
  );
  await page.evaluate(() =>
    document.dispatchEvent(new Event('visibilitychange'))
  );
  await reloaded;
  await expect(page.locator('#loading-indicator')).toBeHidden();

  await expect(row).toBeFocused();
  await expect(popup).toContainText('Flagged pathway 205');
});

test('the table rows work from the keyboard', async ({ page }) => {
  await openLive(page);
  await page.locator('#alerts-table tr[data-objectid="102"]').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.leaflet-popup .alert-popup')).toContainText(
    'Flagged pathway 102'
  );
});

test('the table tab hides and shows the table and remembers it', async ({
  page,
}) => {
  await openLive(page);
  const tab = page.locator('#toggle-table');
  const box = await tab.boundingBox();
  expect(box.height).toBeGreaterThanOrEqual(24);
  expect(box.width).toBeGreaterThanOrEqual(44);

  await tab.click();
  await expect(tab).toHaveAttribute('aria-expanded', 'false');
  await expect(tab).toHaveAccessibleName('Show table');
  await expect(page.locator('#table-wrapper')).toBeHidden();

  await page.reload();
  await expect(page.locator('#status-count')).toHaveText('3');
  await expect(page.locator('#table-wrapper')).toBeHidden();

  await tab.focus();
  await page.keyboard.press('Enter');
  await expect(tab).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#table-wrapper')).toBeVisible();
  const outline = await tab.evaluate((el) => {
    const style = getComputedStyle(el);
    return (
      style.outlineStyle + ' ' + style.outlineWidth + ' ' + style.outlineColor
    );
  });
  expect(outline).toBe('solid 3px rgb(255, 209, 102)');
});

test('the skip link reaches the pathways heading, with the table shown or hidden', async ({
  page,
}) => {
  await openLive(page);
  for (const hideTable of [false, true]) {
    if (hideTable) {
      await page.locator('#toggle-table').click();
      await expect(page.locator('#table-wrapper')).toBeHidden();
    }
    await page.locator('.skip-link').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#table-heading')).toBeFocused();
    // The next stop is inside the table section, not back at the top.
    await page.keyboard.press('Tab');
    await expect(page.locator('#export-csv')).toBeFocused();
  }
});

test('the CSV download carries the grouped pathways and their status', async ({
  page,
}) => {
  await openLive(page);
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#export-csv').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe(
    'dfens-flagged-24h-5in-2026-10-27T18-40-00Z.csv'
  );
  const lines = (await readDownload(download)).split('\r\n');
  expect(lines[0]).toBe(
    'pathway_id,county,watershed,forecast_rain,ndfd_category,area_acres,' +
      'fire_district_status,fire_department,fdid,fd_county,fd_address,' +
      'district_updated,' +
      'window_start_utc,window_end_utc,nws_updated_utc,exported_utc'
  );
  expect(lines[1]).toMatch(
    /^102,Haywood,"Pigeon River, East Fork",6–8″,12,3\.8,district,Cruso Fire Department,44104,Haywood,".*",2023-07-15,/
  );
  expect(lines[2]).toMatch(/^205,.*,district,Asheville Fire Department,11101,/);
  expect(lines).toHaveLength(5);
});

test('the grouped page has no WCAG A or AA problems', async ({ page }) => {
  await openLive(page);
  await expectNoAxeViolations(page);
});

// ---- Districts not known (the stale fixture, an older file) ---------------
test('an older file without districts shows the plain list and the notice', async ({
  page,
}) => {
  await openStale(page);
  await expect(page.locator('#stale-banner')).toBeVisible();
  await expect(page.locator('#stale-banner')).toContainText(
    'has not been able to check for a new forecast in 2 hours'
  );
  await expect(page.locator('#table-summary')).toHaveText(
    '3 pathways in 2 counties'
  );
  await expect(page.locator('#district-notice')).toHaveText(NOTICE_TEXT);
  await expect(page.locator('#district-notice')).toHaveAttribute(
    'role',
    'status'
  );
  await expect(page.locator('.district-notice')).toBeVisible();
  await expect(page.locator('#alerts-table tbody')).toHaveCount(1);
  await expect(page.locator('.group-row')).toHaveCount(0);
  await expect(page.locator('#alerts-table tr[data-objectid]')).toHaveCount(3);

  await page.locator('#alerts-table tr[data-objectid="205"]').click();
  await expect(page.locator('.leaflet-popup .alert-popup')).toContainText(
    'Fire districtNot available'
  );

  const downloadPromise = page.waitForEvent('download');
  await page.locator('#export-csv').click();
  const lines = (await readDownload(await downloadPromise)).split('\r\n');
  expect(lines[1]).toMatch(/^102,Haywood,.*,unavailable,,,,,,2026-/);
});

test('the plain list page has no WCAG A or AA problems', async ({ page }) => {
  await openStale(page);
  await expectNoAxeViolations(page);
});

// ---- Empty and error states -----------------------------------------------
test('the empty fixture shows the none-flagged state', async ({ page }) => {
  await page.goto(pageUrl('empty'));
  await expect(page.locator('#status-count')).toHaveText('0');
  await expect(page.locator('#status-card')).toHaveClass(/is-zero/);
  await expect(page.locator('#table-summary')).toHaveText('None flagged');
  await expect(page.locator('#alerts-table .empty-row')).toContainText(
    'No debris flow pathways'
  );
  await expect(page.locator('.district-notice')).toHaveCount(0);
  await expect(page.locator('#export-csv')).toBeDisabled();
  await expect(page.locator('.leaflet-alerts-pane path')).toHaveCount(0);
});

test('the empty page has no WCAG A or AA problems', async ({ page }) => {
  await page.goto(pageUrl('empty'));
  await expect(page.locator('#status-count')).toHaveText('0');
  await expectNoAxeViolations(page);
});

test('missing data files put the page in the error state', async ({ page }) => {
  await page.goto(pageUrl('does-not-exist'));
  await expect(page.locator('#status-count')).toHaveText('--');
  await expect(page.locator('#status-window')).toHaveText('Unavailable');
  await expect(page.locator('#stale-banner')).toContainText(
    'Forecast data could not be loaded'
  );
  await expect(page.locator('#table-summary')).toHaveText('Data unavailable');
  await expect(page.locator('#alerts-table tbody')).toHaveCount(1);
  await expect(page.locator('#alerts-table .empty-row')).toContainText(
    'could not be loaded'
  );
  await expect(page.locator('.district-notice')).toHaveCount(0);
  await expect(page.locator('#export-csv')).toBeDisabled();
});

test('the layer toggles add and remove their layers', async ({ page }) => {
  const log = await openLive(page);
  // The layer list sits in a collapsed <details>; open it as a user would.
  await page.getByText('Map layers', { exact: true }).click();
  await expect(page.locator('#layer-alerts')).toBeVisible();

  await page.locator('#layer-alerts').uncheck();
  await expect(page.locator('.leaflet-alerts-pane path')).toHaveCount(0);
  await page.locator('#layer-alerts').check();
  await expect(page.locator('.leaflet-alerts-pane path')).toHaveCount(3);

  await page.locator('#layer-mrms').check();
  await expect(
    page.locator('.leaflet-observed-pane img').first()
  ).toHaveAttribute('src', /q2-p24h/);
  await page.locator('#layer-mrms').uncheck();
  await expect(page.locator('.leaflet-observed-pane img')).toHaveCount(0);

  await page.locator('#layer-radar').check();
  await expect(page.locator('.leaflet-radar-pane img').first()).toHaveAttribute(
    'src',
    /nexrad-n0q/
  );

  await page.locator('#layer-ndfd').uncheck();
  await page.locator('#layer-ndfd').check();

  // Parcels and buildings are greyed out at the starting zoom.
  await expect(page.locator('#row-parcels')).toHaveClass(/below-zoom/);
  await expect(page.locator('#row-buildings')).toHaveClass(/below-zoom/);

  expect(log.errors).toEqual([]);
});

// ---- Narrow screens -------------------------------------------------------
for (const width of [375, 320]) {
  test(
    'the grouped page fits ' + width + 'px without sideways scrolling',
    async ({ page }) => {
      await page.setViewportSize({ width, height: 812 });
      await openLive(page);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth
      );
      expect(overflow).toBeLessThanOrEqual(0);
      // The district heading stays within the table's visible width.
      const wrapper = await page.locator('#table-wrapper').boundingBox();
      const head = await page.locator('.group-head').first().boundingBox();
      expect(head.x + head.width).toBeLessThanOrEqual(
        wrapper.x + wrapper.width
      );
    }
  );
}
