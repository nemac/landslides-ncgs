/* =========================================================================
 * map.js — Leaflet map module
 *
 * Public surface (exported on window.DEFNS_MAP):
 *   init()                       -> create the map, panes, basemap selector,
 *                                   and address/place search control
 *   setForecast(geojson)         -> render NDFD forecast polygons
 *   setObserved(geojson)         -> render MRMS observed polygons
 *   setForecastVisible(bool)
 *   setObservedVisible(bool)
 *   setAlerts(geojson)
 *   setAlertsVisible(bool)
 *   setRadarVisible(bool)
 *   setReferenceVisible(bool)    -> NCGS debris flow reference (AGOL)
 *   setParcelsVisible(bool)      -> NC OneMap statewide parcels (clickable)
 *   setBuildingsVisible(bool)    -> Overture building footprints (GeoJSON,
 *                                   lazy-loaded from data/buildings_wnc.geojson)
 *
 * Lessons encoded here from the Streamlit version:
 *   - Each non-basemap layer goes in its own pane with explicit zIndex.
 *     See PANE_ZINDEX in config.js.
 *   - Radar uses retry-until-sized + ResizeObserver to survive iframe-style
 *     zero-dimension initial states.
 * ========================================================================= */

window.DEFNS_MAP = (function () {
  'use strict';

  const CFG = window.DEFNS_CONFIG;

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
      console.warn('[DEFNS] esri-leaflet-geocoder not loaded; map search '
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
    const basemaps = {
      'Light (CartoDB Positron)': L.tileLayer(
        'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
        { attribution: '\u00a9 OpenStreetMap \u00a9 CartoDB', maxZoom: 19 }
      ),
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
    basemaps['Light (CartoDB Positron)'].addTo(map);
    L.control.layers(basemaps, null, { position: 'topright', collapsed: true })
      .addTo(map);
  }

  // ---- Generic precip polygon renderer ------------------------------------
  // Used by both setForecast and setObserved. Same color ramp; the only
  // differences are the pane (z-order) and a tooltip prefix.
  function _renderPrecip(geojson, paneKey, sourceLabel) {
    if (!geojson || !geojson.features || !geojson.features.length) return null;
    return L.geoJSON(geojson, {
      pane: paneKey + 'Pane',
      style: function (feature) {
        const cat = feature.properties.category;
        return {
          fillColor:   CFG.PRECIP_COLORS[cat] || '#888',
          color:       CFG.PRECIP_COLORS[cat] || '#888',
          weight:      0.5,
          fillOpacity: 0.45,
          opacity:     0.6
        };
      },
      onEachFeature: function (feature, layer) {
        const p = feature.properties || {};
        layer.bindTooltip(
          `${sourceLabel} \u00b7 cat ${p.category} \u00b7 ${p.label || ''}`,
          { sticky: true, direction: 'top' }
        );
      }
    });
  }

  function setForecast(geojson) {
    if (layers.forecast) {
      map.removeLayer(layers.forecast);
      layers.forecast = null;
    }
    layers.forecast = _renderPrecip(geojson, 'forecast', 'NDFD');
    if (layers.forecast) layers.forecast.addTo(map);
  }
  function setForecastVisible(visible) {
    if (!layers.forecast) return;
    if (visible && !map.hasLayer(layers.forecast)) layers.forecast.addTo(map);
    if (!visible && map.hasLayer(layers.forecast))  map.removeLayer(layers.forecast);
  }

  function setObserved(geojson) {
    if (layers.observed) {
      map.removeLayer(layers.observed);
      layers.observed = null;
    }
    layers.observed = _renderPrecip(geojson, 'observed', 'MRMS');
    if (layers.observed) layers.observed.addTo(map);
  }
  function setObservedVisible(visible) {
    if (!layers.observed) return;
    if (visible && !map.hasLayer(layers.observed)) layers.observed.addTo(map);
    if (!visible && map.hasLayer(layers.observed))  map.removeLayer(layers.observed);
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
        color:       '#C04C00',
        fillColor:   '#C04C00',
        weight:      2,
        fillOpacity: 0.55,
        opacity:     1.0
      },
      onEachFeature: function (feature, layer) {
        const p = feature.properties || {};
        const cat = p.precip_category;
        const lbl = p.precip_label || '';
        layer.bindPopup(
          `<strong>Polygon ${p.OBJECTID}</strong><br />` +
          `County: ${p.county || '--'}<br />` +
          `Precip: cat ${cat} (${lbl})`
        );
      }
    }).addTo(map);
  }

  function setAlertsVisible(visible) {
    if (!layers.alerts) return;
    if (visible && !map.hasLayer(layers.alerts)) layers.alerts.addTo(map);
    if (!visible && map.hasLayer(layers.alerts))  map.removeLayer(layers.alerts);
  }

  // ---- NEXRAD radar overlay -----------------------------------------------
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
      console.warn('[DEFNS] esri-leaflet not loaded; NCGS reference unavailable');
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
      console.warn('[DEFNS] esri-leaflet not loaded; parcels layer unavailable');
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
  // Below the min-zoom (CFG.OVERTURE_BUILDINGS_MIN_ZOOM), we don't fetch
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
      console.time('[DEFNS] buildings toggle-off');
      if (pane) pane.style.visibility = 'hidden';
      _updateBuildingsZoomHint();
      console.timeEnd('[DEFNS] buildings toggle-off');
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

    console.log('[DEFNS] Fetching buildings manifest from',
                CFG.OVERTURE_BUILDINGS_MANIFEST_URL);
    _buildingsManifestFetch = fetch(CFG.OVERTURE_BUILDINGS_MANIFEST_URL, {
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
        console.log('[DEFNS] Buildings manifest loaded: '
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
        console.error('[DEFNS] Failed to load buildings manifest:', err);
        console.error('[DEFNS] Tip: ensure scripts/refresh.py has been run '
                    + 'at least once so data/buildings/manifest.json exists.');
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
    if (map.getZoom() < CFG.OVERTURE_BUILDINGS_MIN_ZOOM) return;

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
    const url = 'data/' + countyMeta.file;
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
          attribution: CFG.OVERTURE_BUILDINGS_ATTRIBUTION,
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
        console.warn('[DEFNS] Failed to load buildings for county '
                   + geoid + ' (' + (countyMeta.name || 'unknown') + '):',
                   err);
      });
  }

  // Enforce the LRU cache cap. Called after every viewport update. If
  // we're over the limit, drop the least-recently-touched counties from
  // both the LayerGroup and the cache Map.
  function _evictLruCountiesIfNeeded() {
    const cap = CFG.OVERTURE_BUILDINGS_CACHE_MAX_COUNTIES;
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
    setForecast, setForecastVisible,
    setObserved, setObservedVisible,
    setAlerts,   setAlertsVisible,
    setRadarVisible,
    setReferenceVisible,
    setParcelsVisible,
    setBuildingsVisible,
    _internalMap: () => map     // expose for app.js (invalidateSize) and Phase B
  };
})();
