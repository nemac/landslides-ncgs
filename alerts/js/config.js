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

  // Lower bound (inches) of each category, used for "at-or-above" threshold
  // displays like "alert when accumulation >= 5.00 inches" rather than the
  // wordier "5.00-6.00 inches" range form. Mirrors MRMS_CATEGORY_CUTOFFS_INCHES
  // in scripts/config.py: cat N's lower bound is the upper bound of cat N-1.
  const PRECIP_LOWER_BOUNDS_INCHES = {
    0:  0.01, 1:  0.10, 2:  0.25, 3:  0.50, 4:  0.75,
    5:  1.00, 6:  1.50, 7:  2.00, 8:  2.50, 9:  3.00,
    10: 4.00, 11: 5.00, 12: 6.00, 13: 8.00, 14: 10.00,
    15: 12.00, 16: 14.00, 17: 16.00, 18: 18.00, 19: 20.00
  };

  // Format a category as a "at-or-above" threshold string like "5.00\u2033"
  // (using the double-prime mark for inches). The leading ">=" is added
  // by the caller so this returns just the number+inches part.
  function formatThresholdInches(cat) {
    const lb = PRECIP_LOWER_BOUNDS_INCHES[cat];
    if (lb == null) return '--';
    return lb.toFixed(2) + '\u2033';
  }

  // Per-source landing page URLs. Used by app.js to make the "Source"
  // field in the source-meta block a clickable link to the upstream
  // data service. Keys match state.mode values.
  const SOURCE_LINKS = {
    ndfd:       'https://services9.arcgis.com/RHVPKKiFTONKtxq3/' +
                'arcgis/rest/services/NDFD_Precipitation_v1/FeatureServer/1',
    mrms:       'https://mtarchive.geol.iastate.edu/',
    historical: 'https://water.noaa.gov/about/precipitation-data-access'
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

  // NC OneMap statewide parcels - all 100 NC counties + Eastern Band of
  // Cherokee Indians lands, with standardized cadastral attributes
  // (siteadd, parno, scity, szip, cntyname, gisacres, ...). Queryable
  // Feature Server; we use esri-leaflet's bbox-bounded feature layer so
  // only visible parcels are fetched. The /secure/ in the URL is
  // NC OneMap's URL convention - no authentication required.
  // Fields we expose in popups: see _bindParcelsPopup in map.js.
  const NCONEMAP_PARCELS_URL =
    'https://services.nconemap.gov/secure/rest/services/' +
    'NC1Map_Parcels/FeatureServer/1';
  const NCONEMAP_PARCELS_ATTRIBUTION =
    'NC OneMap statewide parcels (NC counties + EBCI)';
  // Minimum map zoom level at which the parcels layer fetches features.
  // Set high enough that a single map view contains well under the
  // service's 5000-record limit even in dense urban areas. Layer toggle
  // shows a hint to zoom in when below this level.
  const NCONEMAP_PARCELS_MIN_ZOOM = 14;

  // Overture Maps Foundation - building footprints distributed as PMTiles.
  // Free public CDN at AWS S3, monthly releases. Visual-only reference
  // layer (no popup interactivity in the PMTiles format we use).
  //
  // URL pattern: overturemaps-extras-us-west-2.s3.amazonaws.com/tiles/{RELEASE}/buildings.pmtiles
  // Release tags follow Overture's YYYY-MM-DD.N naming. Not every
  // calendar month has a release, and the S3 bucket returns 403 for
  // non-existent releases (NOT 404 - so the request "succeeds" but
  // serves no data, which made this hard to diagnose).
  //
  // To pick up a fresher release: visit
  //   https://docs.overturemaps.org/examples/overture-tiles/
  // and copy the release tag they reference in their working example.
  // Their docs are the canonical place to confirm a release is live.
  //
  // The buildings theme contains the feature types "building" (footprints)
  // and "building_part" (sub-parts) - both are painted by paint_rules in
  // map.js so users see complete coverage, not just bare outer shapes.
  const OVERTURE_BUILDINGS_PMTILES_URL =
    'https://overturemaps-extras-us-west-2.s3.amazonaws.com/' +
    'tiles/2026-05-20.0/buildings.pmtiles';
  const OVERTURE_BUILDINGS_ATTRIBUTION =
    '\u00a9 Overture Maps Foundation';

  // Esri World Geocoder - used by the map's search box for address +
  // place lookup. Free tier is generous (~1M queries/year for non-
  // commercial use); no API key required. esri-leaflet-geocoder handles
  // both autocomplete suggestions and full-address resolution against
  // this endpoint internally - we just point it at the same place.
  const ESRI_GEOCODER_URL =
    'https://geocode.arcgis.com/arcgis/rest/services/' +
    'World/GeocodeServer';

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
  // Order from bottom to top:
  //   Buildings reference            -> just above basemap (context layer)
  //   NC parcels reference           -> just above buildings (context layer)
  //   NDFD forecast precipitation    -> alerts data starts here
  //   MRMS observed precipitation    -> above forecast
  //   NEXRAD radar                   -> above precip polygons
  //   Flagged debris flow zones      -> alerts on top (highest priority visual)
  //   NCGS reference layer           -> on top of alerts so user can see all
  //                                     debris flows when reference toggled on
  //
  // The reference layers (buildings, parcels) intentionally sit BELOW the
  // alert-driving layers - they're context, not primary signal. If they
  // were above, they'd visually compete with the precipitation polygons
  // and debris flow alerts that the dashboard is built around.
  const PANE_ZINDEX = {
    buildings:       380,    // Overture building footprints (context)
    parcels:         390,    // NC OneMap parcels (context)
    forecast:        400,    // NDFD forecast polygons
    observed:        410,    // MRMS observed polygons
    radar:           420,    // NEXRAD radar overlay
    alerts:          430,    // flagged debris flow zones
    ncgs_reference:  440     // NCGS debris flow reference (above alerts when on)
  };

  return {
    MAP_CENTER, MAP_ZOOM, WNC_BBOX,
    PRECIP_LABELS, PRECIP_COLORS,
    PRECIP_LOWER_BOUNDS_INCHES, formatThresholdInches,
    SOURCE_LINKS,
    NDFD_DEFAULT_THRESHOLD_CATEGORY,
    NDFD_DEFAULT_WINDOW_HOURS,
    MRMS_DEFAULT_THRESHOLD_CATEGORY,
    NCGS_FEATURESERVER_URL,
    NEXRAD_TILES_URL, NEXRAD_ATTRIBUTION,
    NCONEMAP_PARCELS_URL, NCONEMAP_PARCELS_ATTRIBUTION,
    NCONEMAP_PARCELS_MIN_ZOOM,
    OVERTURE_BUILDINGS_PMTILES_URL, OVERTURE_BUILDINGS_ATTRIBUTION,
    ESRI_GEOCODER_URL,
    AUTO_REFRESH_MS,
    PANE_ZINDEX
  };
})();
