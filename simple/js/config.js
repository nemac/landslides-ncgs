/* =========================================================================
 * config.js - DFENS Simple configuration (keep WINDOW_HOURS and
 * THRESHOLD_CATEGORY in sync with pipeline/settings.py)
 *
 * The simplified dashboard has ONE fixed view, hard-coded here:
 *   source     NWS NDFD precipitation forecast
 *   window     24-hour rain total
 *   threshold  >= 5.00 inches (NDFD category 11)
 *
 * There are no user controls for any of these. To change the view, edit
 * this file (and make sure the shared pipeline writes the matching file).
 * ========================================================================= */

window.DFS_CONFIG = (function () {
  'use strict';

  // ---- Fixed view ---------------------------------------------------------
  const WINDOW_HOURS       = 24;
  const THRESHOLD_CATEGORY = 11;          // NDFD cat 11 = 5.00-6.00"
  const THRESHOLD_INCHES   = 5;

  // ---- Data locations -----------------------------------------------------
  // Forecast data comes from this repo's own pipeline (pipeline/ +
  // .github/workflows/refresh.yml), which checks NDFD every 10 minutes and
  // uploads to simple/data/ next to this page.
  //   status.json                      heartbeat, rewritten on every check
  //   flagged_ndfd_24h_min11.geojson   flagged pathways >= 5" + window meta
  // For testing, ?data=<url> on the page URL overrides this folder.
  const DATA_BASE_URL   = 'data/';
  const FLAGGED_FILE    = 'flagged_ndfd_24h_min11.geojson';
  const FORECAST_FILE   = 'forecast_24h.geojson';   // WNC copy; drives the "no rain" note
  const STATUS_FILE     = 'status.json';

  // Building footprints are static (monthly) and come from the main
  // dashboard's data folder (same origin when served at /simple/).
  // ?buildings=<url> overrides for testing.
  const BUILDINGS_BASE_URL = '../alerts/data/';

  // Show a warning if the pipeline hasn't checked NDFD for this long.
  // Checks run every 10 min; GitHub can delay scheduled runs, so allow
  // generous slack before telling responders the page may be behind.
  const STALE_AFTER_MINUTES = 45;

  // Re-fetch status + data this often while the page is open.
  const AUTO_REFRESH_MS = 5 * 60 * 1000;

  // ---- Map ------------------------------------------------------------------
  const MAP_CENTER = [35.55, -82.55];
  const MAP_ZOOM   = 8;

  // Precip category labels (NDFD's 20 bins). Only the >= 5" ones show up
  // in this dashboard, but the full table keeps labels correct if the
  // threshold constant is ever changed.
  const PRECIP_LABELS = {
    0: '0.01–0.10″', 1: '0.10–0.25″', 2: '0.25–0.50″',
    3: '0.50–0.75″', 4: '0.75–1.00″', 5: '1.00–1.50″',
    6: '1.50–2.00″', 7: '2.00–2.50″', 8: '2.50–3.00″',
    9: '3.00–4.00″', 10: '4.00–5.00″', 11: '5–6″',
    12: '6–8″', 13: '8–10″', 14: '10–12″',
    15: '12–14″', 16: '14–16″', 17: '16–18″',
    18: '18–20″', 19: 'over 20″'
  };

  // NDFD color ramp - same as the full dashboard (config.js PRECIP_COLORS).
  const PRECIP_COLORS = {
    0: '#7E22CE', 1: '#9333EA', 2: '#A855F7', 3: '#C084FC', 4: '#D8B4FE',
    5: '#86EFAC', 6: '#4ADE80', 7: '#22C55E', 8: '#16A34A', 9: '#FACC15',
    10: '#EAB308', 11: '#F59E0B', 12: '#F97316', 13: '#EA580C', 14: '#DC2626',
    15: '#B91C1C', 16: '#991B1B', 17: '#7F1D1D', 18: '#A21CAF', 19: '#86198F'
  };

  // NEXRAD radar tiles (IEM n0q composite) - same source as the full dashboard.
  const NEXRAD_TILES_URL =
    'https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q/{z}/{x}/{y}.png';
  const NEXRAD_ATTRIBUTION = 'NOAA NEXRAD via Iowa Environmental Mesonet';

  // MRMS observed 24-hour precipitation (reference only, no intersections).
  // IEM tile cache of the NOAA MRMS 24-h QPE mosaic - the same MRMS data
  // whose GRIB archive lives at mtarchive.geol.iastate.edu, but already
  // rendered as map tiles. Refreshed hourly at IEM (5-min cache header).
  const MRMS_24H_TILES_URL =
    'https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/q2-p24h/{z}/{x}/{y}.png?t={t}';
  const MRMS_24H_LEGEND_URL = 'https://mesonet.agron.iastate.edu/images/mrms_q3_p24h.png';
  const MRMS_ATTRIBUTION = 'NOAA MRMS via Iowa Environmental Mesonet';

  // MRMS 24-h color ramp, sampled pixel-by-pixel from IEM's official
  // legend (images/mrms_q3_p24h.png, 2026-10). Positions are % along the
  // bar; the scale is non-linear (0-1 in spans ~40%, then 1 per step).
  const MRMS_24H_RAMP = [
    [0.0,  '#000cff'], [13.5, '#00d8ff'], [13.9, '#00fef0'], [29.8, '#00fe00'],
    [44.8, '#e4fe00'], [45.6, '#feea00'], [61.1, '#fe0000'], [62.7, '#fe0000'],
    [76.6, '#fe00d2'], [77.0, '#fe00fe'], [100,  '#fee8fe']
  ];
  // Tick label '' = tick mark only (labels there would collide).
  const MRMS_24H_TICKS = [
    [9.1, '\u00bc'], [19.0, '\u00bd'], [28.9, '\u00be'], [38.9, '1'], [46.8, '2'],
    [54.8, '3'], [62.7, '4'], [70.6, '5'], [74.6, ''], [80.6, '10'], [90.5, '15\u2033']
  ];

  // Fallback if status.json has no check_interval_minutes.
  const CHECK_INTERVAL_MINUTES = 10;

  // ---- Upstream services (fetched directly by the browser) ---------------
  const NDFD_SOURCE_URL =
    'https://services9.arcgis.com/RHVPKKiFTONKtxq3/arcgis/rest/services/' +
    'NDFD_Precipitation_v1/FeatureServer/1';
  const NCGS_FEATURESERVER_URL =
    'https://services1.arcgis.com/PwLrOgCfU0cYShcG/arcgis/rest/services/' +
    'CDF_Landslides_Model/FeatureServer/0';
  const NCONEMAP_PARCELS_URL =
    'https://services.nconemap.gov/secure/rest/services/' +
    'NC1Map_Parcels/MapServer/1';
  const NCONEMAP_PARCELS_ATTRIBUTION = 'NC OneMap statewide parcels';
  const NCONEMAP_PARCELS_MIN_ZOOM = 14;
  const ESRI_GEOCODER_URL =
    'https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer';

  // ---- Buildings (per-county files written by the shared pipeline) -------
  const BUILDINGS_MANIFEST_FILE = 'buildings/manifest.json';
  const BUILDINGS_ATTRIBUTION   = '© Overture Maps Foundation';
  const BUILDINGS_MIN_ZOOM      = 12;
  const BUILDINGS_CACHE_MAX_COUNTIES = 20;

  // ---- Pane z-order (bottom to top) ---------------------------------------
  const PANE_ZINDEX = {
    buildings:      380,
    parcels:        390,
    forecast:       400,
    observed:       405,
    radar:          410,
    ncgs_reference: 420,
    alerts:         430
  };

  function _base(param, fallback) {
    let base = fallback;
    try {
      const o = new URLSearchParams(window.location.search).get(param);
      if (o) base = o;
    } catch (e) { /* ignore */ }
    return base.endsWith('/') ? base : base + '/';
  }
  function dataBase()      { return _base('data', DATA_BASE_URL); }
  function buildingsBase() { return _base('buildings', BUILDINGS_BASE_URL); }

  return {
    WINDOW_HOURS, THRESHOLD_CATEGORY, THRESHOLD_INCHES,
    FLAGGED_FILE, FORECAST_FILE, STATUS_FILE, PRECIP_COLORS,
    NEXRAD_TILES_URL, NEXRAD_ATTRIBUTION, CHECK_INTERVAL_MINUTES,
    MRMS_24H_TILES_URL, MRMS_24H_LEGEND_URL, MRMS_ATTRIBUTION,
    MRMS_24H_RAMP, MRMS_24H_TICKS, STALE_AFTER_MINUTES, AUTO_REFRESH_MS,
    MAP_CENTER, MAP_ZOOM, PRECIP_LABELS,
    NDFD_SOURCE_URL, NCGS_FEATURESERVER_URL,
    NCONEMAP_PARCELS_URL, NCONEMAP_PARCELS_ATTRIBUTION, NCONEMAP_PARCELS_MIN_ZOOM,
    ESRI_GEOCODER_URL,
    BUILDINGS_MANIFEST_FILE, BUILDINGS_ATTRIBUTION,
    BUILDINGS_MIN_ZOOM, BUILDINGS_CACHE_MAX_COUNTIES,
    PANE_ZINDEX, dataBase, buildingsBase
  };
})();
