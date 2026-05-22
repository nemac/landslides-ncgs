/* =========================================================================
 * config.js — frontend configuration
 * Mirror of Python config.py constants. Keep these in sync when either side
 * changes. If a constant is only used by one side, prefer to keep it there.
 * ========================================================================= */

window.DEFNS_CONFIG = (function () {
  'use strict';

  // ---- Map view defaults --------------------------------------------------
  // Centered on WNC, zoom level shows roughly Asheville to the state border.
  const MAP_CENTER = [35.55, -82.55];
  const MAP_ZOOM = 8;

  // WNC bounding box (lonMin, latMin, lonMax, latMax) in WGS84.
  // Used to filter forecast/observed precipitation polygons before rendering.
  const WNC_BBOX = [-84.5, 34.8, -81.0, 36.7];

  // ---- NDFD precipitation categories --------------------------------------
  // 20 bins from NWS, from "trace" through ">= 20 inches".
  // Index = NDFD category number. label = display string.
  const PRECIP_LABELS = {
    0:  '.01\u2013.10\u2033',
    1:  '.10\u2013.25\u2033',
    2:  '.25\u2013.50\u2033',
    3:  '.50\u2013.75\u2033',
    4:  '.75\u20131.00\u2033',
    5:  '1.00\u20131.50\u2033',
    6:  '1.50\u20132.00\u2033',
    7:  '2.00\u20132.50\u2033',
    8:  '2.50\u20133.00\u2033',
    9:  '3.00\u20134.00\u2033',
    10: '4.00\u20135.00\u2033',
    11: '5.00\u20136.00\u2033',
    12: '6.00\u20138.00\u2033',
    13: '8.00\u201310.00\u2033',
    14: '10.00\u201312.00\u2033',
    15: '12.00\u201314.00\u2033',
    16: '14.00\u201316.00\u2033',
    17: '16.00\u201318.00\u2033',
    18: '18.00\u201320.00\u2033',
    19: '>20.00\u2033'
  };

  // NDFD's official color ramp. Same scheme used in NWS NDFD products and
  // in the Streamlit version (mirror of map_folium.py PRECIP_COLORS).
  // Light blues for trace amounts, ramping through greens, yellows, oranges,
  // reds, magentas for the heaviest amounts.
  const PRECIP_COLORS = {
    0:  '#7E22CE',   // very light, trace-only
    1:  '#9333EA',
    2:  '#A855F7',
    3:  '#C084FC',
    4:  '#D8B4FE',
    5:  '#86EFAC',
    6:  '#4ADE80',
    7:  '#22C55E',
    8:  '#16A34A',
    9:  '#FACC15',
    10: '#EAB308',
    11: '#F59E0B',
    12: '#F97316',
    13: '#EA580C',
    14: '#DC2626',
    15: '#B91C1C',
    16: '#991B1B',
    17: '#7F1D1D',
    18: '#A21CAF',
    19: '#86198F'
  };

  // ---- Detection thresholds & defaults ------------------------------------
  // Default forecast window and threshold for NDFD mode.
  // Default threshold for MRMS mode (separate because the 1-hour observed
  // semantics differ from N-hour forecast accumulation).
  const NDFD_DEFAULT_THRESHOLD_CATEGORY = 11;   // >= 5.00" / 12hr
  const NDFD_DEFAULT_WINDOW_HOURS = 12;
  const MRMS_DEFAULT_THRESHOLD_CATEGORY = 5;    // >= 1.00" / 1hr

  // ---- Data sources -------------------------------------------------------
  // NCGS debris flow polygons - live AGOL FeatureServer, queried via
  // esri-leaflet. NCGS team maintains; we always read latest.
  const NCGS_FEATURESERVER_URL =
    'https://services1.arcgis.com/PwLrOgCfU0cYShcG/arcgis/rest/services/' +
    'CDF_Landslides_Model/FeatureServer/0';

  // NEXRAD radar tile overlay (Iowa Environmental Mesonet, n0q composite).
  // Same URL we use in the Streamlit version.
  const NEXRAD_TILES_URL =
    'https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/' +
    'nexrad-n0q/{z}/{x}/{y}.png';
  const NEXRAD_ATTRIBUTION = 'NOAA NEXRAD via Iowa Environmental Mesonet';

  // ---- Auto-refresh -------------------------------------------------------
  // GitHub Actions writes new JSON every 15 minutes. The frontend polls
  // for it at a slightly longer interval so we don't hammer the bucket and
  // so the user gets fresh data without too much network churn.
  const AUTO_REFRESH_MS = 15 * 60 * 1000;   // 15 min

  // ---- Pane z-indexes (lesson from Streamlit version) ---------------------
  // Leaflet's default tilePane is 200. Anything we want above basemaps must
  // be in its own pane with a higher zIndex. This is what saved us from the
  // "radar tiles loaded but invisible under satellite basemap" bug.
  //
  // Order from bottom to top, matching the sidebar layer-toggle order (#7):
  //   NDFD forecast precipitation  -> bottom (forecast is conceptual; show first)
  //   MRMS observed precipitation  -> above forecast
  //   NEXRAD radar                 -> above precip polygons
  //   Flagged debris flow zones    -> alerts on top (highest priority visual)
  //   NCGS reference layer         -> on top of alerts so user can see all
  //                                   debris flows when reference toggled on
  const PANE_ZINDEX = {
    forecast:        400,    // NDFD forecast polygons
    observed:        410,    // MRMS observed polygons
    radar:           420,    // NEXRAD radar overlay
    alerts:          430,    // flagged debris flow zones
    ncgs_reference:  440     // NCGS debris flow reference (above alerts when on)
  };

  return {
    MAP_CENTER, MAP_ZOOM, WNC_BBOX,
    PRECIP_LABELS, PRECIP_COLORS,
    NDFD_DEFAULT_THRESHOLD_CATEGORY,
    NDFD_DEFAULT_WINDOW_HOURS,
    MRMS_DEFAULT_THRESHOLD_CATEGORY,
    NCGS_FEATURESERVER_URL,
    NEXRAD_TILES_URL, NEXRAD_ATTRIBUTION,
    AUTO_REFRESH_MS,
    PANE_ZINDEX
  };
})();
