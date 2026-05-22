/* =========================================================================
 * map.js — Leaflet map module
 *
 * Public surface (exported on window.DEFNS_MAP):
 *   init()                       -> create the map, panes, basemap selector
 *   setForecast(geojson)         -> render NDFD forecast polygons
 *   setObserved(geojson)         -> render MRMS observed polygons
 *   setForecastVisible(bool)
 *   setObservedVisible(bool)
 *   setAlerts(geojson)
 *   setAlertsVisible(bool)
 *   setRadarVisible(bool)
 *   setReferenceVisible(bool)
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
    reference: null
  };

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
    Object.entries(CFG.PANE_ZINDEX).forEach(([name, z]) => {
      const pane = map.createPane(name + 'Pane');
      pane.style.zIndex = z;
      // overlay panes shouldn't intercept clicks meant for the map itself;
      // disable pointer-events except for the alerts pane (popups).
      if (name !== 'alerts') {
        pane.style.pointerEvents = 'none';
      }
      panes[name] = pane;
    });

    _addBasemaps();
    return map;
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
  function setReferenceVisible(visible) {
    if (visible && !layers.reference) {
      if (typeof L.esri === 'undefined') {
        console.warn(
          '[DEFNS] esri-leaflet not loaded; NCGS reference layer unavailable'
        );
        return;
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
      layers.reference.addTo(map);
    } else if (!visible && layers.reference) {
      map.removeLayer(layers.reference);
      layers.reference = null;
    }
  }

  // ---- Public API ---------------------------------------------------------
  return {
    init,
    setForecast, setForecastVisible,
    setObserved, setObservedVisible,
    setAlerts,   setAlertsVisible,
    setRadarVisible,
    setReferenceVisible,
    _internalMap: () => map     // expose for app.js (invalidateSize) and Phase B
  };
})();
