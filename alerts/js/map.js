/* =========================================================================
 * map.js — Leaflet map module
 *
 * Public surface (exported on window.DEFNS_MAP):
 *   init()                    -> create the map, panes, basemap selector
 *   setPrecip(geojson, label) -> render NDFD or MRMS polygons
 *   clearPrecip()
 *   setAlerts(geojson)        -> render flagged debris flow polygons
 *   clearAlerts()
 *   setRadarVisible(bool)     -> toggle the NEXRAD overlay
 *   setReferenceVisible(bool) -> toggle the NCGS debris flow reference layer
 *   setPrecipVisible(bool)
 *   setAlertsVisible(bool)
 *
 * Lessons encoded here from the Streamlit version:
 *   - Each non-basemap layer goes in its own pane with explicit zIndex.
 *     Sharing tilePane with basemaps caused invisible radar tiles under
 *     the Satellite basemap. See PANE_ZINDEX in config.js.
 *   - Radar uses retry-until-sized + ResizeObserver to survive iframe-style
 *     zero-dimension initial states. (Less critical here without iframe,
 *     but cheap insurance.)
 * ========================================================================= */

window.DEFNS_MAP = (function () {
  'use strict';

  const CFG = window.DEFNS_CONFIG;

  let map = null;
  let panes = {};
  let layers = {
    precip:    null,
    radar:     null,
    alerts:    null,
    reference: null
  };

  // ---- init() -------------------------------------------------------------
  function init() {
    map = L.map('map', {
      center: CFG.MAP_CENTER,
      zoom:   CFG.MAP_ZOOM,
      // Keyboard nav (arrow keys pan, +/- zoom) is on by default in Leaflet.
      // We also set keyboardPanDelta explicitly so it's consistent.
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
      // disable pointer-events except for the alerts pane which has popups.
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
    // Light by default - matches dashboard tone, doesn't fight the precip colors
    basemaps['Light (CartoDB Positron)'].addTo(map);
    L.control.layers(basemaps, null, { position: 'topright', collapsed: true })
      .addTo(map);
  }

  // ---- Precipitation polygons (NDFD or MRMS) ------------------------------
  function setPrecip(geojson, ariaLabel) {
    clearPrecip();
    if (!geojson || !geojson.features || !geojson.features.length) return;

    layers.precip = L.geoJSON(geojson, {
      pane: 'precipPane',
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
          `Category ${p.category} \u00b7 ${p.label || ''}`,
          { sticky: true, direction: 'top' }
        );
      }
    }).addTo(map);

    // Update the screen-reader description of the layer
    if (ariaLabel) {
      const el = document.getElementById('layer-precip-label');
      if (el) el.textContent = ariaLabel;
    }
  }

  function clearPrecip() {
    if (layers.precip) {
      map.removeLayer(layers.precip);
      layers.precip = null;
    }
  }

  function setPrecipVisible(visible) {
    if (!layers.precip) return;
    if (visible && !map.hasLayer(layers.precip)) layers.precip.addTo(map);
    if (!visible && map.hasLayer(layers.precip))  map.removeLayer(layers.precip);
  }

  // ---- Flagged debris flow polygons (alerts) ------------------------------
  function setAlerts(geojson) {
    clearAlerts();
    if (!geojson || !geojson.features || !geojson.features.length) return;

    layers.alerts = L.geoJSON(geojson, {
      pane: 'alertsPane',
      style: {
        // Orange to match the metric card and CTA palette
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

  function clearAlerts() {
    if (layers.alerts) {
      map.removeLayer(layers.alerts);
      layers.alerts = null;
    }
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
      // esri-leaflet renders FeatureServer features client-side. Slow when
      // zoomed out (it queries everything in view), but works without
      // republishing the NCGS data.
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
    setPrecip, clearPrecip, setPrecipVisible,
    setAlerts, clearAlerts, setAlertsVisible,
    setRadarVisible,
    setReferenceVisible,
    _internalMap: () => map     // expose for debugging only
  };
})();
