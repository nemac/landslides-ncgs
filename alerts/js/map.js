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
 *   setBuildingsVisible(bool)    -> Overture building footprints (PMTiles)
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
      fields:  ['OBJECTID', 'parno', 'siteadd', 'scity', 'szip',
                'cntyname', 'gisacres', 'transfdate'],
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

  // ---- Overture building footprints layer (visual reference) --------------
  // Toggleable PMTiles layer fetched from Overture's public CDN. Visual
  // only - no popups or click interaction (the protomaps-leaflet plugin
  // renders to canvas, not real DOM features, so it can't carry feature
  // attributes through to a click handler the way a Feature Server can).
  //
  // Styled as muted gray fills with thin outlines, intentionally
  // subordinated to the alert-driving layers above it. We don't want
  // building footprints visually competing with debris flow polygons.
  function setBuildingsVisible(visible) {
    if (!visible) {
      if (layers.buildings) {
        map.removeLayer(layers.buildings);
        layers.buildings = null;
      }
      return;
    }
    if (layers.buildings) return;  // already on
    if (typeof protomapsL === 'undefined'
        || typeof protomapsL.leafletLayer !== 'function') {
      console.warn('[DEFNS] protomaps-leaflet not loaded; '
                 + 'buildings layer unavailable');
      return;
    }
    console.log('[DEFNS] Loading building footprints from',
                CFG.OVERTURE_BUILDINGS_PMTILES_URL);
    layers.buildings = protomapsL.leafletLayer({
      url:  CFG.OVERTURE_BUILDINGS_PMTILES_URL,
      pane: 'buildingsPane',
      attribution: CFG.OVERTURE_BUILDINGS_ATTRIBUTION,
      // IMPORTANT: protomaps-leaflet's option keys are snake_case
      // (paint_rules, label_rules), NOT camelCase. Using camelCase
      // means the plugin gets no rules, draws nothing, and never even
      // initiates tile fetches - so the layer appears "broken" with
      // no errors. Verified against the plugin's GitHub examples.
      //
      // Paint rules: all-black fill, no stroke. Overture's PMTiles use
      // the FEATURE TYPE name as the dataLayer key inside the tiles,
      // not the theme name. Per Overture's docs, the buildings theme
      // has two feature types: "building" (footprints) and
      // "building_part" (sub-parts). We paint both. We also include
      // a "buildings" plural fallback in case a future release ever
      // switches to theme-name layers - the plugin silently no-ops on
      // dataLayer names that aren't in the tiles, so listing extras
      // is harmless.
      paint_rules: [
        {
          dataLayer: 'building',
          symbolizer: new protomapsL.PolygonSymbolizer({
            fill:    '#000000',
            opacity: 1,
            stroke:  '#000000',
            width:   0,
          }),
        },
        {
          dataLayer: 'building_part',
          symbolizer: new protomapsL.PolygonSymbolizer({
            fill:    '#000000',
            opacity: 1,
            stroke:  '#000000',
            width:   0,
          }),
        },
        {
          dataLayer: 'buildings',
          symbolizer: new protomapsL.PolygonSymbolizer({
            fill:    '#000000',
            opacity: 1,
            stroke:  '#000000',
            width:   0,
          }),
        },
      ],
      label_rules: [],   // no labels - keeps the map uncluttered
    });
    layers.buildings.addTo(map);
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
