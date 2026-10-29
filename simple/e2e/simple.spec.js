// The real page in a real browser: scripts load in order, Leaflet draws the
// flagged pathways, the table and map agree, the toggles work, and the CSV
// downloads. Data comes from simple/test/fixtures/ through ?data=. unpkg
// stays reachable because it serves Leaflet and esri-leaflet; every other
// host (basemap tiles, NDFD, NCGS, parcels, fonts) is blocked, and the
// blocked NDFD layer proves the map notice. The clock is fixed to match the fixtures.
const { test, expect } = require('@playwright/test');

const FIXED_NOW = new Date('2026-10-27T18:40:00Z');
const ALLOWED_HOSTS = new Set(['127.0.0.1', 'unpkg.com']);

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

test('the live fixture renders the cards, the table and the map', async ({
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
    '3 pathways in 2 counties.'
  );

  const rows = page.locator('#alerts-tbody tr[data-objectid]');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText('Haywood');
  await expect(rows.nth(0)).toContainText('6–8″');
  await expect(page.locator('#alerts-tbody')).not.toContainText('407');

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

test('selecting a row zooms the map to that pathway and opens its popup', async ({
  page,
}) => {
  await openLive(page);
  const zoomBefore = await page.evaluate(() =>
    window.DFS_MAP._internalMap().getZoom()
  );
  await page.locator('#alerts-tbody tr[data-objectid="205"]').click();
  await expect(page.locator('.leaflet-popup .alert-popup')).toContainText(
    'Flagged pathway 205'
  );
  await expect(page.locator('.leaflet-popup .alert-popup')).toContainText(
    'French Broad River'
  );
  await expect
    .poll(() => page.evaluate(() => window.DFS_MAP._internalMap().getZoom()))
    .toBeGreaterThan(zoomBefore);
});

test('the table rows work from the keyboard', async ({ page }) => {
  await openLive(page);
  await page.locator('#alerts-tbody tr[data-objectid="102"]').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.leaflet-popup .alert-popup')).toContainText(
    'Flagged pathway 102'
  );
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

test('the stale fixture shows the warning banner', async ({ page }) => {
  await page.goto(pageUrl('stale'));
  await expect(page.locator('#status-count')).toHaveText('3');
  await expect(page.locator('#stale-banner')).toBeVisible();
  await expect(page.locator('#stale-banner')).toContainText(
    'has not been able to check for a new forecast in 2 hours'
  );
});

test('the empty fixture shows the none-flagged state', async ({ page }) => {
  await page.goto(pageUrl('empty'));
  await expect(page.locator('#status-count')).toHaveText('0');
  await expect(page.locator('#status-card')).toHaveClass(/is-zero/);
  await expect(page.locator('#alerts-tbody .empty-row')).toContainText(
    'No debris flow pathways'
  );
  await expect(page.locator('#export-csv')).toBeDisabled();
  await expect(page.locator('.leaflet-alerts-pane path')).toHaveCount(0);
});

test('missing data files put the page in the error state', async ({ page }) => {
  await page.goto(pageUrl('does-not-exist'));
  await expect(page.locator('#status-count')).toHaveText('--');
  await expect(page.locator('#status-window')).toHaveText('Unavailable');
  await expect(page.locator('#stale-banner')).toContainText(
    'Forecast data could not be loaded'
  );
  await expect(page.locator('#alerts-tbody .empty-row')).toContainText(
    'could not be loaded'
  );
  await expect(page.locator('#export-csv')).toBeDisabled();
});

test('the CSV download carries the three flagged pathways', async ({
  page,
}) => {
  await openLive(page);
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#export-csv').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe(
    'dfens-flagged-24h-5in-2026-10-27T18-40-00Z.csv'
  );
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const lines = Buffer.concat(chunks).toString('utf8').split('\r\n');
  expect(lines[0]).toMatch(/^county,watershed,forecast_rain/);
  expect(lines[1]).toMatch(
    /^Haywood,"Pigeon River, East Fork",6–8″,12,3\.8,102,/
  );
  expect(lines).toHaveLength(5);
});

test('the page fits a phone-width viewport without sideways scrolling', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await openLive(page);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth
  );
  expect(overflow).toBeLessThanOrEqual(0);
});
