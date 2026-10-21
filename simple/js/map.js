/* =========================================================================
 * map.js - Leaflet map for DFENS Simple
 *
 * Adapted from the full dashboard's map.js (landslides-ncgs/alerts/js).
 * Kept: basemaps + selector, address search, flagged pathways, NCGS
 * reference pathways, NC parcels (clickable, owner-name parser),
 * per-county building footprints (viewport-loaded, LRU cache).
 * Also: NDFD forecast precip (24 h, full coverage, live), MRMS observed
 * 24-h precip (IEM tiles, reference only) and NEXRAD radar.
 * Removed: MRMS observed precipitation.
 *
 * Public surface (window.DFS_MAP):
 *   init()
 *   setForecastPeriod(meta) / setForecastVisible(bool)
 *   setRadarVisible(bool)
 *   setAlerts(geojson) / setAlertsVisible(bool) / zoomToAlert(objectid)
 *   setReferenceVisible(bool)  -> Promise
 *   setParcelsVisible(bool)
 *   setBuildingsVisible(bool)
 * ========================================================================= */

window.DFS_MAP = (function () {
  'use strict';

  const CFG = window.DFS_CONFIG;

  let map = null;
  let panes = {};
  let layers = {
    forecast:  null,
    observed:  null,
    radar:     null,
    alerts:    null,
    reference: null,
    parcels:   null,
    buildings: null
  };

  // Geocoder search control - kept here so we can refer to it later if
  // we ever need to programmatically focus or clear it (not currently
  // exposed in the public API, just held for lifecycle management).
  let geocoderControl = null;

  // ---- init() -------------------------------------------------------------
  function init() {
    map = L.map('map', {
      center: CFG.MAP_CENTER,
      zoom:   CFG.MAP_ZOOM,
      keyboard:        true,
      keyboardPanDelta: 80,
      zoomControl:     true
    });

    // Create dedicated panes for each layer category so they stack
    // predictably above the basemap regardless of add/remove order.
    //
    // Pointer-events: only panes that need click interaction get pointer
    // events. The `alerts` pane has clickable polygons for flow popups;
    // the `parcels` pane has clickable parcels for attribute popups.
    // All other panes are visual-only and should let clicks through to
    // whichever clickable layer is under the cursor.
    const CLICKABLE_PANES = new Set(['alerts', 'parcels']);
    Object.entries(CFG.PANE_ZINDEX).forEach(([name, z]) => {
      const pane = map.createPane(name + 'Pane');
      pane.style.zIndex = z;
      if (!CLICKABLE_PANES.has(name)) {
        pane.style.pointerEvents = 'none';
      }
      panes[name] = pane;
    });

    _addBasemaps();
    _addSearchControl();
    return map;
  }

  // ---- Search control -----------------------------------------------------
  // Address & place search box, anchored to the map's top-left. Uses
  // Esri's World Geocoder (free tier, no API key required). When the
  // user picks a result, the map pans and zooms to that location and a
  // transient marker pops up briefly so the user can see what was found.
  //
  // Accessibility notes:
  //   - The plugin renders a real <input type="text"> with proper
  //     placeholder text and ARIA labelling for the suggestion listbox.
  //   - We add an explicit aria-label after construction in case the
  //     plugin version we're on doesn't set one (defensive belt-and-
  //     suspenders since plugin behavior changes between versions).
  //   - Keyboard nav (Tab to focus, arrow keys through suggestions,
  //     Enter to select, Esc to close) is provided by the plugin.
  function _addSearchControl() {
    if (typeof L.esri === 'undefined'
        || typeof L.esri.Geocoding === 'undefined'
        || typeof L.esri.Geocoding.geosearch !== 'function') {
      console.warn('[DFS] esri-leaflet-geocoder not loaded; map search '
                 + 'control will be unavailable.');
      return;
    }
    geocoderControl = L.esri.Geocoding.geosearch({
      position:        'topleft',
      placeholder:     'Search city, address, or place\u2026',
      useMapBounds:    false,            // search globally, not just WNC
      expanded:        true,             // always-visible box, not collapsed icon
      collapseAfterResult: false,        // keep the input visible after selection
      title:           'Address & place search',
      providers: [
        L.esri.Geocoding.arcgisOnlineProvider({
          // Public free-tier endpoint; no API key required.
          url: CFG.ESRI_GEOCODER_URL,
        }),
      ],
    }).addTo(map);

    // The plugin places the rendered input inside the control DOM. Find
    // it and apply our own a11y label as a safety net.
    setTimeout(function () {
      const inputs = document.querySelectorAll('.geocoder-control input');
      inputs.forEach(function (inp) {
        if (!inp.getAttribute('aria-label')) {
          inp.setAttribute('aria-label', 'Search for a city, address, or place');
        }
        if (!inp.getAttribute('autocomplete')) {
          inp.setAttribute('autocomplete', 'off');
        }
      });
    }, 0);

    // On a successful result, the plugin's default behavior calls
    // fitBounds() on the result's extent. For point-like results
    // (addresses), that extent can be a tiny degenerate envelope which
    // produces an off-center, over-or-under-zoomed view. We override
    // with an explicit pan-to-center + setZoom for predictable behavior,
    // and drop a brief highlight marker so the user has a visual anchor.
    //
    // Zoom heuristic: smaller place types (PointAddress, StreetAddress)
    // zoom in tighter; larger ones (Locality, City) stay zoomed out
    // farther for context. Falls back to zoom 14 if the result type is
    // unknown.
    geocoderControl.on('results', function (data) {
      if (!data.results || !data.results.length) return;
      const r = data.results[0];
      const placeType = (r.properties && r.properties.Type) || '';
      const zoom = _zoomForPlaceType(placeType);

      // Center the map on the result and set zoom. This replaces the
      // plugin's default fitBounds, which was placing the result in the
      // top-left corner instead of centered.
      map.setView(r.latlng, zoom);

      // Transient marker - removed after a few seconds.
      const marker = L.marker(r.latlng, {
        keyboard: false,
        alt: 'Search result: ' + (r.text || ''),
      }).addTo(map);
      setTimeout(function () { map.removeLayer(marker); }, 5000);
    });
  }

  // Map Esri World Geocoder result types to a sensible default zoom.
  // The Type field comes from the geocoder response (Esri's spec lists
  // ~100 types; we cluster them into 3 bands here).
  function _zoomForPlaceType(placeType) {
    if (!placeType) return 14;
    const t = placeType.toLowerCase();
    // Tight zoom for specific addresses and POIs
    if (t.includes('address')
        || t.includes('postal')
        || t.includes('building')
        || t.includes('poi')
        || t.includes('business')) return 17;
    // Medium zoom for neighborhoods, populated places (cities, towns)
    if (t.includes('city')
        || t.includes('locality')
        || t.includes('populated')
        || t.includes('neighborhood')
        || t.includes('district')
        || t.includes('subregion')) return 12;
    // Wider zoom for counties, states, regions
    if (t.includes('county')
        || t.includes('state')
        || t.includes('country')
        || t.includes('region')
        || t.includes('province')) return 9;
    return 14;
  }

  // ---- Basemaps -----------------------------------------------------------
  function _addBasemaps() {
    // Default basemap changed 2026-08 from CartoDB Positron to Esri Gray:
    //   - CartoDB began requiring an API key on basemaps.cartocdn.com in
    //     late Aug 2026; unauthenticated raster requests now render
    //     watermarked "API KEY REQUIRED" tiles worldwide.
    //   - Esri's "legacy" raster basemaps (accessed via L.esri.basemapLayer)
    //     are still keyless, and we already have esri-leaflet loaded for
    //     the parcels layer - zero new dependencies.
    //   - Visual style is very close to CartoDB Positron: muted, light,
    //     minimal. Attribution is added automatically by the basemapLayer.
    //
    // Basemap options (updated 2026-08):
    //   1. Light (Esri Gray)      - keyless, default, close to Positron style
    //   2. Dark (Esri Dark Gray)  - keyless, dark counterpart of #1
    //   3. Streets (OpenStreetMap)- keyless fallback if Esri ever deprecates
    //   4. Satellite (Esri Imagery)- keyless, raw satellite/aerial imagery
    //
    // Both Esri Gray and Dark Gray bundle a base tile layer + label overlay
    // into a single L.layerGroup so the basemap selector treats them as
    // one item. Adding just the base layer without labels leaves the map
    // unlabelled (no city/road names); pairing them gives the standard
    // CartoDB-Positron-like experience.
    const basemaps = {
      'Light (Esri Gray)': L.layerGroup([
        L.esri.basemapLayer('Gray'),
        L.esri.basemapLayer('GrayLabels'),
      ]),
      'Dark (Esri Dark Gray)': L.layerGroup([
        L.esri.basemapLayer('DarkGray'),
        L.esri.basemapLayer('DarkGrayLabels'),
      ]),
      'Streets (OpenStreetMap)': L.tileLayer(
        'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
        { attribution: '\u00a9 OpenStreetMap contributors', maxZoom: 19 }
      ),
      'Satellite (Esri World Imagery)': L.tileLayer(
        'https://server.arcgisonline.com/ArcGIS/rest/services/' +
        'World_Imagery/MapServer/tile/{z}/{y}/{x}',
        { attribution: 'Tiles \u00a9 Esri', maxZoom: 19 }
      )
    };
    // Default = Light (Esri Gray / Light Gray Canvas). All four options remain available
    // via the basemap selector; this just picks which one is on the map
    // when the page first loads.
    basemaps['Light (Esri Gray)'].addTo(map);
    L.control.layers(basemaps, null, { position: 'topright', collapsed: true })
      .addTo(map);
  }

  // ---- NDFD forecast precipitation (full NDFD coverage, live) -------------
  // Reference layer only, so it is NOT limited to WNC: it reads the NDFD
  // FeatureServer directly (like parcels), filtered to the same 24-h
  // period the pipeline used for the flagged pathways. esri-leaflet only
  // requests features in the current view and simplifies geometry by zoom,
  // so zooming out to CONUS stays light.
  let _forecastKey = null;
  function _fmtTs(d) {   // "YYYY-MM-DD HH:MM:SS" in UTC for ArcGIS SQL
    return d.toISOString().slice(0, 19).replace('T', ' ');
  }
  function setForecastPeriod(meta) {
    if (!meta || !meta.window_end || typeof L.esri === 'undefined') return;
    const end = new Date(meta.window_end);
    const key = meta.window_start + '|' + meta.window_end + '|' + (meta.issued || '');
    if (key === _forecastKey && layers.forecast) return;   // unchanged
    _forecastKey = key;

    // The layer is cumulative from the cycle start; the 6-h period that
    // ends at window_end holds the whole window's total. Its fromdate is
    // stored 1 s past the boundary, so match +/- 1 minute.
    const periodStart = new Date(end.getTime() - 6 * 3600 * 1000);
    const lo = new Date(periodStart.getTime() - 60000);
    const hi = new Date(periodStart.getTime() + 60000);
    const where = "fromdate >= timestamp '" + _fmtTs(lo) + "' AND " +
                  "fromdate <= timestamp '" + _fmtTs(hi) + "'";

    const wasOn = !layers.forecast || map.hasLayer(layers.forecast);
    if (layers.forecast) map.removeLayer(layers.forecast);
    layers.forecast = L.esri.featureLayer({
      url:   CFG.NDFD_SOURCE_URL,
      where: where,
      fields: ['OBJECTID', 'category', 'label'],
      pane:  'forecastPane',
      simplifyFactor: 0.5,
      precision: 5,
      style: function (feature) {
        const c = CFG.PRECIP_COLORS[feature.properties.category] || '#888';
        return { fillColor: c, color: c, weight: 0.5, fillOpacity: 0.45, opacity: 0.6 };
      },
      attribution: 'NOAA NWS NDFD'
    });
    const cb = document.getElementById('layer-ndfd');
    if ((cb ? cb.checked : true) && wasOn) layers.forecast.addTo(map);
  }
  function setForecastVisible(visible) {
    if (!layers.forecast) return;
    if (visible && !map.hasLayer(layers.forecast)) layers.forecast.addTo(map);
    if (!visible && map.hasLayer(layers.forecast))  map.removeLayer(layers.forecast);
  }

  // ---- MRMS observed 24-hour precipitation (reference tiles) --------------
  // Display only - no intersections. Tiles are cache-busted with a time
  // stamp so an open page picks up IEM's hourly updates on each refresh.
  function _mrmsStamp() { return String(Math.floor(Date.now() / 600000)); }  // 10-min buckets
  function setObservedVisible(visible) {
    if (visible && !layers.observed) {
      layers.observed = L.tileLayer(CFG.MRMS_24H_TILES_URL, {
        pane:          'observedPane',
        attribution:   CFG.MRMS_ATTRIBUTION,
        opacity:       0.7,
        maxNativeZoom: 10,     // IEM tiles stop at z10; upscale beyond that
        t:             _mrmsStamp()
      });
      layers.observed.addTo(map);
    } else if (!visible && layers.observed) {
      map.removeLayer(layers.observed);
      layers.observed = null;
    }
  }
  function refreshObserved() {
    if (!layers.observed) return;
    const t = _mrmsStamp();
    if (layers.observed.options.t !== t) {
      layers.observed.options.t = t;
      layers.observed.redraw();
    }
  }

  // ---- NEXRAD radar overlay (same as full dashboard) ----------------------
  function setRadarVisible(visible) {
    if (visible && !layers.radar) {
      layers.radar = L.tileLayer(CFG.NEXRAD_TILES_URL, {
        pane:        'radarPane',
        attribution: CFG.NEXRAD_ATTRIBUTION,
        opacity:     0.75,
        minZoom:     2,
        maxZoom:     10
      });
      layers.radar.addTo(map);
    } else if (!visible && layers.radar) {
      map.removeLayer(layers.radar);
      layers.radar = null;
    }
  }

  // ---- Flagged debris flow polygons (alerts) ------------------------------
  function setAlerts(geojson) {
    if (layers.alerts) {
      map.removeLayer(layers.alerts);
      layers.alerts = null;
    }
    if (!geojson || !geojson.features || !geojson.features.length) return;

    layers.alerts = L.geoJSON(geojson, {
      pane: 'alertsPane',
      style: {
        color:       '#FF6A13',
        fillColor:   '#FF6A13',
        weight:      2,
        fillOpacity: 0.6,
        opacity:     1.0
      },
      onEachFeature: function (feature, layer) {
        const p = feature.properties || {};
        layer.bindPopup(
          '<div class="alert-popup">' +
          '<strong>Flagged pathway ' + _escape(p.OBJECTID) + '</strong>' +
          '<dl>' +
          '<dt>Forecast rain</dt><dd>' +
            _escape(CFG.PRECIP_LABELS[p.max_category] || '--') + '</dd>' +
          '<dt>County</dt><dd>' + _escape(p.county || '--') + '</dd>' +
          '<dt>Watershed</dt><dd>' + _escape(p.watershed || '--') + '</dd>' +
          '</dl></div>'
        );
      }
    }).addTo(map);
  }

  function zoomToAlert(objectid) {
    if (!layers.alerts) return;
    let target = null;
    layers.alerts.eachLayer(function (l) {
      if (String(l.feature.properties.OBJECTID) === String(objectid)) target = l;
    });
    if (!target) return;
    if (!map.hasLayer(layers.alerts)) layers.alerts.addTo(map);
    map.fitBounds(target.getBounds(), { padding: [60, 60], maxZoom: 15 });
    target.openPopup();
  }

  function setAlertsVisible(visible) {
    if (!layers.alerts) return;
    if (visible && !map.hasLayer(layers.alerts)) layers.alerts.addTo(map);
    if (!visible && map.hasLayer(layers.alerts))  map.removeLayer(layers.alerts);
  }

  // ---- NCGS reference layer (debris flows from AGOL) ----------------------
  // Returns a Promise that resolves when the layer's first load batch
  // completes (i.e., the visible features are drawn). Caller can use this
  // to drive a loading indicator that resolves correctly even on slow
  // AGOL responses. Resolves immediately if disabling, or if the layer
  // is already loaded.
  function setReferenceVisible(visible) {
    if (!visible) {
      if (layers.reference) {
        map.removeLayer(layers.reference);
        layers.reference = null;
      }
      return Promise.resolve();
    }

    if (layers.reference) {
      return Promise.resolve();        // already on; nothing to wait for
    }

    if (typeof L.esri === 'undefined') {
      console.warn('[DFS] esri-leaflet not loaded; NCGS reference unavailable');
      return Promise.resolve();
    }

    layers.reference = L.esri.featureLayer({
      url:  CFG.NCGS_FEATURESERVER_URL,
      pane: 'ncgs_referencePane',
      style: {
        color:       '#529866',
        weight:      0.5,
        fillOpacity: 0.18,
        opacity:     0.7
      }
    });
    const ref = layers.reference;
    ref.addTo(map);

    // Resolve on the first 'load' event esri-leaflet fires; this signals
    // that the visible-extent batch of features has finished arriving.
    // Race against a hard 30s timeout in case the service is unresponsive.
    return new Promise(function (resolve) {
      let settled = false;
      const done = function () {
        if (settled) return;
        settled = true;
        ref.off('load', done);
        resolve();
      };
      ref.on('load', done);
      setTimeout(done, 30000);
    });
  }

  // ---- NC OneMap parcels layer (clickable reference) ----------------------
  // Toggleable layer fetched live from NC OneMap's Feature Server, scoped
  // to the visible map extent. Only loads at zoom >= CFG.NCONEMAP_PARCELS_MIN_ZOOM
  // because the service has a 5000-record cap per request and dense WNC
  // areas would otherwise truncate (or, worse, return 5000 random parcels
  // from the visible extent giving the user a misleading visual).
  //
  // Clicking a parcel opens a popup with site address, parcel ID, county,
  // acres, and last-transform date. Popup is keyboard-accessible (Tab to
  // focus, Esc to close - both Leaflet defaults).
  //
  // The min-zoom hint label in the layer toggle UI gets shown/hidden from
  // app.js via a 'zoomend' listener, so the user knows why nothing
  // appears when they toggle on while zoomed out.
  function setParcelsVisible(visible) {
    if (!visible) {
      if (layers.parcels) {
        map.removeLayer(layers.parcels);
        layers.parcels = null;
      }
      return;
    }
    if (layers.parcels) return;  // already on
    if (typeof L.esri === 'undefined') {
      console.warn('[DFS] esri-leaflet not loaded; parcels layer unavailable');
      return;
    }
    layers.parcels = L.esri.featureLayer({
      url:     CFG.NCONEMAP_PARCELS_URL,
      minZoom: CFG.NCONEMAP_PARCELS_MIN_ZOOM,
      pane:    'parcelsPane',
      // Pull only the attributes our popup uses - smaller payload, faster
      // rendering, and lets us be explicit about which fields the popup
      // can rely on existing.
      //
      // Owner name comes from the single `ownname` field (esriFieldTypeString,
      // alias "Owner Name", length 200). Earlier attempts used ownfrst /
      // ownlast as parsed subfields but those don't exist on this MapServer
      // sublayer - the service silently returns undefined for unknown
      // fields, so the popup was quietly showing em-dash for every parcel.
      //
      // In NC, parcel ownership records are public information per the
      // Public Records Act, so displaying them on a public-facing dashboard
      // is legitimate. See _parseOwnerName for the "LAST FIRST" -> "LAST,
      // FIRST" transformation with entity detection.
      fields:  ['OBJECTID', 'parno', 'siteadd', 'scity', 'szip',
                'cntyname', 'gisacres', 'transfdate', 'ownname'],
      style: {
        // Red outline (#ff0909) at thin weight, no fill so debris flows
        // underneath remain visible. Keeps the layer present but visually
        // unobtrusive given how many parcels there are at this zoom.
        color:       '#ff0909',
        weight:      0.75,
        opacity:     0.95,
        fillOpacity: 0,
      },
      attribution: CFG.NCONEMAP_PARCELS_ATTRIBUTION,
    }).bindPopup(_buildParcelPopup);
    layers.parcels.addTo(map);
  }

  // Build the HTML content for a parcel popup. Handles missing/null fields
  // gracefully (vacant land has no site address; some counties don't
  // publish all fields).
  function _buildParcelPopup(layer) {
    const p = layer.feature && layer.feature.properties || {};
    const addr   = p.siteadd && p.siteadd.trim() ? p.siteadd : null;
    const cityZ  = [p.scity, p.szip].filter(Boolean).join(' ').trim();
    const parno  = p.parno && p.parno.trim() ? p.parno : '\u2014';
    const county = p.cntyname || '\u2014';
    const acres  = (typeof p.gisacres === 'number' && isFinite(p.gisacres))
                   ? p.gisacres.toFixed(2) + ' ac'
                   : '\u2014';
    // Owner name comes as a single `ownname` field in NC OneMap format,
    // typically "LAST FIRST" or "LAST FIRST MIDDLE" (space-separated,
    // last-name-first, often all caps). We parse to "LAST, FIRST MIDDLE"
    // for cleaner reading, but skip parsing for common entity patterns
    // like "SMITH ENTERPRISES LLC" where the "last name first" convention
    // doesn't apply. See _parseOwnerName below.
    const owner = _parseOwnerName(p.ownname) || '\u2014';
    // transfdate is an Esri epoch-ms timestamp; if present, format as date
    let updated = '\u2014';
    if (p.transfdate) {
      const d = new Date(p.transfdate);
      if (!isNaN(d.getTime())) {
        updated = d.toISOString().slice(0, 10);  // YYYY-MM-DD
      }
    }
    return (
      '<div class="parcel-popup" role="region" aria-label="Parcel details">'
      +   '<div class="parcel-popup-addr">'
      +     (addr ? _escape(addr) : '<em>No site address</em>')
      +   '</div>'
      +   (cityZ
            ? '<div class="parcel-popup-city">' + _escape(cityZ) + '</div>'
            : '')
      +   '<dl class="parcel-popup-fields">'
      +     '<dt>Owner</dt><dd>'    + _escape(owner) + '</dd>'
      +     '<dt>Parcel #</dt><dd>' + _escape(parno) + '</dd>'
      +     '<dt>County</dt><dd>'   + _escape(county) + '</dd>'
      +     '<dt>Acres</dt><dd>'    + _escape(acres) + '</dd>'
      +     '<dt>Updated</dt><dd>'  + _escape(updated) + '</dd>'
      +   '</dl>'
      +   '<div class="parcel-popup-source">'
      +     'Source: NC OneMap'
      +   '</div>'
      + '</div>'
    );
  }

  // Tiny string-escape helper for popup content. We're not building user-
  // submitted content into HTML, but the data DOES come from upstream so
  // we still escape defensively.
  function _escape(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Parse an NC OneMap ownname string into a display-friendly form.
  //
  // NC parcel data typically stores ownname as "LAST FIRST" or
  // "LAST FIRST MIDDLE" (space-separated, last name first, often all caps
  // - this is the cadastral convention across most NC counties). Reading
  // this order aloud sounds awkward ("SMITH JOHN A"), so we transform to
  // "LAST, FIRST MIDDLE" ("SMITH, JOHN A") for the popup.
  //
  // The transformation is skipped when the record is an entity rather
  // than a person - e.g., "SMITH ENTERPRISES LLC" would become the
  // misleading "SMITH, ENTERPRISES LLC" under naive parsing. We detect
  // entities by looking for common entity-suffix keywords as any token.
  //
  // Also passes through:
  //   - Records that already contain a comma (assume they're pre-parsed)
  //   - Single-token strings (mononyms, cropped values, unknown format)
  //
  // Returns the display string, or null if the input was empty/missing.
  const _OWNER_ENTITY_KEYWORDS = new Set([
    'LLC', 'L.L.C.', 'INC', 'INC.', 'CORP', 'CORP.', 'CORPORATION',
    'LTD', 'LTD.', 'LP', 'LLP', 'PLLC',
    'TRUST', 'ESTATE', 'FAMILY',
    'CHURCH', 'MINISTRY', 'MINISTRIES', 'ASSOCIATION', 'ASSN', 'ASSOC',
    'COMPANY', 'CO', 'CO.',
    'PARTNERSHIP', 'PARTNERS', 'GROUP',
    'FARMS', 'PROPERTIES', 'HOLDINGS', 'INVESTMENTS',
    'ENTERPRISES', 'VENTURES', 'FOUNDATION',
    'DEVELOPMENT', 'DEVELOPERS',
    'AUTHORITY', 'DEPARTMENT', 'DEPT',
  ]);
  function _parseOwnerName(raw) {
    const s = (raw || '').trim();
    if (!s) return null;

    // Already comma-formatted - trust the upstream format.
    if (s.indexOf(',') !== -1) return s;

    const tokens = s.split(/\s+/);
    if (tokens.length < 2) return s;   // mononym / truncated / single-name

    // Entity detection - any token matches a known entity suffix?
    for (const t of tokens) {
      if (_OWNER_ENTITY_KEYWORDS.has(t.toUpperCase())) {
        return s;   // display raw for entities
      }
    }

    // Individual: "LAST FIRST [MIDDLE...]" -> "LAST, FIRST MIDDLE"
    const lastName = tokens[0];
    const rest     = tokens.slice(1).join(' ');
    return lastName + ', ' + rest;
  }

  // ---- Overture building footprints layer (visual reference) --------------
  // Toggleable layer rendering all-black building footprints. Sourced from
  // Overture Maps Foundation, extracted by scripts/refresh.py into per-
  // county GeoJSONs at data/buildings/{GEOID}.geojson plus a manifest at
  // data/buildings/manifest.json.
  //
  // ARCHITECTURE (2026-07-14, replacing the earlier single-file approach):
  // The full WNC dataset is ~2M buildings across ~30 counties = way too
  // big to ship as a single GeoJSON. Instead:
  //
  //   1. On first toggle-on, fetch the small manifest (~5 KB).
  //   2. Register moveend + zoomend listeners.
  //   3. On each viewport change, figure out which counties intersect
  //      the visible bounds AND we're above min-zoom. Fetch any that
  //      aren't yet in memory; add them to the rendered layer.
  //   4. Keep an LRU cache of loaded counties bounded at CACHE_MAX
  //      (~20 counties, ~100-300 MB browser RAM). Evict least-recently-
  //      used when full.
  //
  // Below the min-zoom (CFG.BUILDINGS_MIN_ZOOM), we don't fetch
  // new counties, but existing loaded counties stay rendered (canvas
  // renderer skips off-screen features so there's no visual downside).
  // The "(zoom in to load)" hint next to the toggle updates accordingly.
  //
  // Failure behavior: silent-skip + console log. If one county file fails
  // to load (404 or network error), other counties render as normal;
  // the failed county appears blank. This isolates buildings failures
  // from the alert-driving layers.
  //
  // Rendering perf: ALL county sub-layers share a single L.canvas
  // renderer (_buildingsCanvas). This means (a) toggling on/off is a
  // single-element DOM operation regardless of how many counties are
  // loaded, and (b) the browser only paints one canvas per frame instead
  // of one-per-county.
  let _buildingsManifest      = null;    // loaded once, kept for the session
  let _buildingsLayerGroup    = null;    // container in map for county sub-layers
  let _buildingsCounties      = null;    // Map<GEOID, {layer, lastAccessed}>
  let _buildingsInFlight      = null;    // Set<GEOID> - dedupe overlapping fetches
  let _buildingsListenersOn   = false;   // whether moveend/zoomend are wired
  let _buildingsManifestFetch = null;    // in-flight manifest promise (dedupe)
  let _buildingsCanvas        = null;    // shared canvas renderer for all counties

  function setBuildingsVisible(visible) {
    const pane = panes.buildings;  // the DOM element for buildingsPane

    if (!visible) {
      // Hide by CSS visibility rather than display. `visibility: hidden`
      // keeps the pane in the layout tree (no reflow triggered) and
      // just skips paint. Combined with pointer-events:none it becomes
      // fully invisible and inert. This is meaningfully faster than
      // display:none for panes containing heavy canvas content, since
      // display:none forces the browser to un-composite the canvas's
      // GPU layer.
      //
      // The LayerGroup stays on the map, the canvas stays cached,
      // everything is ready for instant re-show. The gating on the
      // checkbox state in _updateBuildingsForViewport prevents wasted
      // fetches while the layer is hidden.
      //
      // Perf timing wraps this to help diagnose the reported toggle-off
      // lag - if our JS timing is fast (<10ms) but the perceived lag is
      // longer, the delay is browser-side (repaint of hidden canvas)
      // and not something we can shorten further from JavaScript.
      console.time('[DFS] buildings toggle-off');
      if (pane) pane.style.visibility = 'hidden';
      _updateBuildingsZoomHint();
      console.timeEnd('[DFS] buildings toggle-off');
      return;
    }

    // Turning on: initialize state if needed
    if (!_buildingsCounties) _buildingsCounties = new Map();
    if (!_buildingsInFlight) _buildingsInFlight = new Set();

    if (!_buildingsLayerGroup) {
      _buildingsLayerGroup = L.layerGroup([]);
    }
    if (!map.hasLayer(_buildingsLayerGroup)) {
      _buildingsLayerGroup.addTo(map);
    }
    // Un-hide the pane (may be visibility:hidden from a previous toggle-off).
    // The pane's pointer-events property is set to 'none' at pane creation
    // (buildings isn't in the CLICKABLE_PANES list) so we don't touch it here.
    if (pane) pane.style.visibility = '';

    // First toggle-on ever: fetch the manifest, then wire the viewport
    // listeners. Subsequent toggle-ons skip straight to updating.
    if (_buildingsManifest) {
      _wireBuildingsViewportListeners();
      _updateBuildingsForViewport();
      _updateBuildingsZoomHint();
      return;
    }
    if (_buildingsManifestFetch) return;  // dedupe: manifest fetch already in flight

    console.log('[DFS] Fetching buildings manifest from',
                CFG.buildingsBase() + CFG.BUILDINGS_MANIFEST_FILE);
    _buildingsManifestFetch = fetch(CFG.buildingsBase() + CFG.BUILDINGS_MANIFEST_FILE, {
      cache: 'default',   // manifest changes ~monthly; browser cache is fine
    })
      .then(function (resp) {
        if (!resp.ok) {
          throw new Error('HTTP ' + resp.status + ' fetching buildings manifest');
        }
        return resp.json();
      })
      .then(function (manifest) {
        _buildingsManifest = manifest;
        _buildingsManifestFetch = null;
        console.log('[DFS] Buildings manifest loaded: '
                  + manifest.counties.length + ' counties, '
                  + (manifest.total_features || 0).toLocaleString()
                  + ' features, '
                  + (manifest.total_size_mb || 0) + ' MB total.');
        // Confirm the user still wants the layer (they may have toggled
        // off during the manifest fetch).
        const stillRequested =
          document.getElementById('layer-buildings') &&
          document.getElementById('layer-buildings').checked;
        if (!stillRequested) return;
        _wireBuildingsViewportListeners();
        _updateBuildingsForViewport();
        _updateBuildingsZoomHint();
      })
      .catch(function (err) {
        _buildingsManifestFetch = null;
        console.error('[DFS] Failed to load buildings manifest:', err);
        console.error('[DFS] Tip: check BUILDINGS_BASE_URL in config.js points at '
                    + 'the main dashboard data folder.');
      });
  }

  // Wire moveend + zoomend listeners the FIRST time the layer is toggled
  // on. Idempotent: only registers once per session. Listeners keep
  // running for the rest of the page life even when the layer is off,
  // but they no-op unless the LayerGroup is on the map.
  function _wireBuildingsViewportListeners() {
    if (_buildingsListenersOn) return;
    map.on('moveend', _updateBuildingsForViewport);
    map.on('zoomend', function () {
      _updateBuildingsForViewport();
      _updateBuildingsZoomHint();
    });
    _buildingsListenersOn = true;
  }

  // Called on every viewport change (moveend/zoomend) while the buildings
  // layer is on. Figures out which counties intersect the visible
  // viewport, starts fetches for any not yet cached, and evicts LRU
  // counties if the cache is over its limit.
  //
  // No-ops if:
  //   - the layer-buildings checkbox is unchecked (user toggled off)
  //   - manifest not loaded yet (still fetching)
  //   - current zoom is below the min-zoom threshold
  //
  // The LayerGroup stays on the map even when the layer is toggled off
  // (we use pane visibility to hide it), so we can't gate on
  // map.hasLayer() - the checkbox is the source of truth.
  function _updateBuildingsForViewport() {
    const cb = document.getElementById('layer-buildings');
    if (!cb || !cb.checked) return;
    if (!_buildingsManifest || !_buildingsLayerGroup) return;
    if (map.getZoom() < CFG.BUILDINGS_MIN_ZOOM) return;

    const bounds = map.getBounds();
    const west  = bounds.getWest();
    const east  = bounds.getEast();
    const south = bounds.getSouth();
    const north = bounds.getNorth();

    // Find counties whose bbox intersects the viewport
    const now = Date.now();
    let fetched = 0;
    for (const county of _buildingsManifest.counties) {
      const b = county.bbox;   // [minX, minY, maxX, maxY]
      const intersects =
        !(west > b[2] || east < b[0] || south > b[3] || north < b[1]);
      if (!intersects) continue;

      // Already cached? Touch its LRU timestamp and move on.
      if (_buildingsCounties.has(county.geoid)) {
        _buildingsCounties.get(county.geoid).lastAccessed = now;
        continue;
      }
      // Already fetching? Dedupe.
      if (_buildingsInFlight.has(county.geoid)) continue;

      // Not yet cached and not yet fetching - kick off the fetch.
      _fetchAndRenderCounty(county);
      fetched++;
    }

    _evictLruCountiesIfNeeded();
  }

  // Fetch one county's GeoJSON, build a Leaflet layer from it, add it to
  // the LayerGroup, and record it in the LRU cache. Failure = silent
  // skip + console log (per team's decision - buildings are reference-
  // only, alert layers are unaffected).
  function _fetchAndRenderCounty(countyMeta) {
    const geoid = countyMeta.geoid;
    _buildingsInFlight.add(geoid);
    const url = CFG.buildingsBase() + countyMeta.file;
    fetch(url, { cache: 'default' })
      .then(function (resp) {
        if (!resp.ok) {
          throw new Error('HTTP ' + resp.status + ' for ' + geoid);
        }
        return resp.json();
      })
      .then(function (geojson) {
        _buildingsInFlight.delete(geoid);
        // The user may have toggled off, evicted this county, or
        // otherwise made this fetch's result no longer wanted.
        if (!_buildingsLayerGroup || !_buildingsCounties) return;
        const cb = document.getElementById('layer-buildings');
        if (!cb || !cb.checked) return;

        // Lazy-create the shared canvas renderer once. All county sub-
        // layers reuse it so toggling the LayerGroup is a single-element
        // DOM op and the browser only paints one canvas per frame.
        if (!_buildingsCanvas) {
          _buildingsCanvas = L.canvas({ padding: 0.1, pane: 'buildingsPane' });
        }
        const countyLayer = L.geoJSON(geojson, {
          pane: 'buildingsPane',
          attribution: CFG.BUILDINGS_ATTRIBUTION,
          renderer: _buildingsCanvas,
          style: {
            // All-black fill, no stroke - same styling as before, just
            // now applied per-county
            fillColor:   '#000000',
            fillOpacity: 1.0,
            color:       '#000000',
            weight:      0,
            stroke:      false,
          },
          interactive: false,
        });
        _buildingsLayerGroup.addLayer(countyLayer);
        _buildingsCounties.set(geoid, {
          layer: countyLayer,
          lastAccessed: Date.now(),
        });
      })
      .catch(function (err) {
        _buildingsInFlight.delete(geoid);
        // Silent skip per team's failure-behavior decision: log to
        // console but don't show a user-visible warning. Other
        // counties keep rendering; alert-driving layers are unaffected.
        console.warn('[DFS] Failed to load buildings for county '
                   + geoid + ' (' + (countyMeta.name || 'unknown') + '):',
                   err);
      });
  }

  // Enforce the LRU cache cap. Called after every viewport update. If
  // we're over the limit, drop the least-recently-touched counties from
  // both the LayerGroup and the cache Map.
  function _evictLruCountiesIfNeeded() {
    const cap = CFG.BUILDINGS_CACHE_MAX_COUNTIES;
    while (_buildingsCounties.size > cap) {
      // Find the LRU entry. Small cache (~20 entries) makes a linear
      // scan fine; no need for a fancier data structure.
      let lruGeoid = null;
      let lruTime = Infinity;
      for (const [geoid, entry] of _buildingsCounties) {
        if (entry.lastAccessed < lruTime) {
          lruTime = entry.lastAccessed;
          lruGeoid = geoid;
        }
      }
      if (!lruGeoid) break;   // shouldn't happen, defensive
      const entry = _buildingsCounties.get(lruGeoid);
      if (_buildingsLayerGroup && entry && entry.layer) {
        _buildingsLayerGroup.removeLayer(entry.layer);
      }
      _buildingsCounties.delete(lruGeoid);
    }
  }

  // Keep the "(zoom in to load)" hint next to the Buildings toggle. We
  // intentionally leave the hint always visible (rather than toggling
  // it in/out based on current zoom) - hiding it made the row height
  // shift, which caused the layer name to jump above the checkbox
  // baseline when the hint disappeared. Always-visible = consistent
  // row height in the layers panel.
  function _updateBuildingsZoomHint() {
    const hint = document.getElementById('buildings-zoom-hint');
    if (!hint) return;
    hint.classList.remove('is-hidden');
  }

  // ---- Public API ---------------------------------------------------------
  return {
    init,
    setForecastPeriod, setForecastVisible,
    setRadarVisible,
    setObservedVisible, refreshObserved,
    setAlerts, setAlertsVisible, zoomToAlert,
    setReferenceVisible,
    setParcelsVisible,
    setBuildingsVisible,
    _internalMap: () => map
  };
})();
