// A stand-in for the parts of Leaflet and esri-leaflet that map.js calls.
// Every layer records its options, knows whether it is on the map, and
// can fire the events map.js listens for, so the tests check what map.js
// asked Leaflet to draw without a browser.
function fakeLeaflet(document) {
  const created = {
    maps: [],
    featureLayers: [],
    tileLayers: [],
    geoJsonLayers: [],
    controls: [],
  };

  function layer(extra) {
    const l = {
      _map: null,
      _handlers: {},
      addTo(map) {
        map.addLayer(this);
        return this;
      },
      remove() {
        if (this._map) this._map.removeLayer(this);
        return this;
      },
      on(event, fn) {
        (this._handlers[event] = this._handlers[event] || []).push(fn);
        return this;
      },
      off(event, fn) {
        this._handlers[event] = (this._handlers[event] || []).filter(
          (h) => h !== fn
        );
        return this;
      },
      fire(event, data) {
        (this._handlers[event] || []).slice().forEach((fn) => fn(data));
      },
      bindPopup(content) {
        this.popup = content;
        return this;
      },
      redraw() {
        this.redraws = (this.redraws || 0) + 1;
      },
    };
    return Object.assign(l, extra);
  }

  function fakeMap(id, options) {
    const layers = new Set();
    const handlers = {};
    const map = {
      id,
      options,
      layers,
      controls: new Set(),
      panes: {},
      zoom: options.zoom,
      bounds: { west: -83, east: -82, south: 35, north: 36 },
      createPane(name) {
        const el = document.createElement('div');
        el.className = 'leaflet-pane ' + name;
        this.panes[name] = el;
        return el;
      },
      addLayer(l) {
        layers.add(l);
        l._map = this;
      },
      removeLayer(l) {
        layers.delete(l);
        l._map = null;
      },
      hasLayer(l) {
        return layers.has(l);
      },
      getZoom() {
        return this.zoom;
      },
      getBounds() {
        const b = this.bounds;
        return {
          getWest: () => b.west,
          getEast: () => b.east,
          getSouth: () => b.south,
          getNorth: () => b.north,
        };
      },
      on(event, fn) {
        (handlers[event] = handlers[event] || []).push(fn);
      },
      fire(event) {
        (handlers[event] || []).forEach((fn) => fn());
      },
      fitBounds(bounds, opts) {
        this.fitted = { bounds, opts };
      },
      setView(latlng, zoom) {
        this.view = { latlng, zoom };
      },
    };
    created.maps.push(map);
    return map;
  }

  function control(opts) {
    const c = {
      opts,
      addTo(map) {
        this.el = this.onAdd(map);
        this._map = map;
        map.controls.add(this);
        return this;
      },
      remove() {
        if (this._map) this._map.controls.delete(this);
      },
    };
    created.controls.push(c);
    return c;
  }
  control.layers = (basemaps, overlays, opts) => ({
    basemaps,
    opts,
    addTo(map) {
      map.layersControl = this;
      return this;
    },
  });

  const L = {
    map: fakeMap,
    layerGroup(initial) {
      const members = new Set(initial || []);
      return layer({
        members,
        addLayer(l) {
          members.add(l);
        },
        removeLayer(l) {
          members.delete(l);
        },
      });
    },
    tileLayer(url, options) {
      const l = layer({ url, options });
      created.tileLayers.push(l);
      return l;
    },
    geoJSON(geojson, options) {
      const sub = (geojson.features || []).map((feature) => {
        const fl = layer({
          feature,
          getBounds: () => ({ of: feature.properties.OBJECTID }),
          openPopup() {
            this.popupOpen = true;
          },
        });
        if (options.onEachFeature) options.onEachFeature(feature, fl);
        return fl;
      });
      const l = layer({
        geojson,
        options,
        sub,
        eachLayer(fn) {
          sub.forEach(fn);
        },
      });
      created.geoJsonLayers.push(l);
      return l;
    },
    canvas(options) {
      return { canvas: true, options };
    },
    marker(latlng, options) {
      return layer({ latlng, options });
    },
    control,
    DomUtil: {
      create(tag, className) {
        const el = document.createElement(tag);
        el.className = className;
        return el;
      },
    },
    esri: {
      basemapLayer(name) {
        return layer({ basemap: name });
      },
      featureLayer(options) {
        const l = layer({ options });
        created.featureLayers.push(l);
        return l;
      },
    },
  };

  return { L, created };
}

module.exports = { fakeLeaflet };
