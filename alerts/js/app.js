/* =========================================================================
 * app.js — main dashboard controller
 *
 * Responsibilities:
 *   - Initialize map and load mock data (Phase 3 swaps to live fetch)
 *   - Wire up sidebar controls to map + alerts logic
 *   - Manage detection mode (NDFD vs MRMS) and update header/UI accordingly
 *   - Manage auto-refresh timer
 *   - Manage ADA live-region announcements for refreshes & state changes
 * ========================================================================= */

(function () {
  'use strict';

  const CFG  = window.DEFNS_CONFIG;
  const MAP  = window.DEFNS_MAP;
  const AL   = window.DEFNS_ALERTS;
  const MOCK = window.DEFNS_MOCK;

  // ---- DOM references (collected once, reused) ----------------------------
  const $ = (id) => document.getElementById(id);

  const els = {
    // Mode + controls
    modeNdfd:        $('mode-ndfd'),
    modeMrms:        $('mode-mrms'),
    thresholdSlider: $('threshold-slider'),
    thresholdLabel:  $('threshold-readout-label'),
    windowSelect:    $('window-select'),
    windowGroup:     $('window-control-group'),
    mrmsWindowNote:  $('mrms-window-note'),

    // Layer toggles
    layerPrecip:    $('layer-precip'),
    layerRadar:     $('layer-radar'),
    layerAlerts:    $('layer-alerts'),
    layerReference: $('layer-reference'),
    layerPrecipLabel: $('layer-precip-label'),

    // Refresh
    manualRefresh:    $('manual-refresh'),
    autoRefreshToggle:$('auto-refresh-toggle'),
    lastUpdated:      $('last-updated'),

    // Header / subtitle / metrics
    subtitle:           $('mode-subtitle'),
    metricIssuedTime:   $('metric-issued-time'),
    metricIssuedDate:   $('metric-issued-date'),
    metricWindow:       $('metric-window'),
    metricWindowSub:    $('metric-window-sub'),
    metricThreshold:    $('metric-threshold'),
    metricThresholdSub: $('metric-threshold-sub'),
    metricFlagged:      $('metric-flagged'),
    metricFlaggedSub:   $('metric-flagged-sub'),
    metricFlaggedCard:  $('metric-flagged-card'),

    // Alerts table
    alertsTbody:    $('alerts-tbody'),
    alertsSummary: $('alerts-summary')
  };

  // ---- State --------------------------------------------------------------
  const state = {
    mode:      'ndfd',                                  // 'ndfd' | 'mrms'
    threshold: CFG.NDFD_DEFAULT_THRESHOLD_CATEGORY,     // 0..19
    window:    CFG.NDFD_DEFAULT_WINDOW_HOURS,           // hours (NDFD only)
    autoRefreshTimer: null
  };

  // =====================================================================
  // INITIALIZATION
  // =====================================================================
  function init() {
    MAP.init();
    _wireEvents();
    _syncControlsFromState();

    // Phase 3a: try to fetch live data files. If they're missing (e.g.
    // refresh.py hasn't been run yet) or fail to load, fall back to the
    // mock fixtures so the page is always functional.
    _loadLiveData().then(refresh);

    _startAutoRefresh();
  }

  // =====================================================================
  // LIVE DATA FETCH (Phase 3a)
  // =====================================================================
  // Replaces what was hardcoded in mock-data.js. We mutate MOCK in place
  // because everything downstream (refresh(), _currentDataset()) reads
  // from MOCK.NDFD_FORECAST and MOCK.MRMS_OBSERVED - so a successful fetch
  // transparently upgrades the dashboard from mock to live data.
  // =====================================================================
  function _loadLiveData() {
    return Promise.allSettled([
      _fetchInto('data/forecast.geojson', 'NDFD_FORECAST'),
      _fetchInto('data/observed.geojson', 'MRMS_OBSERVED')
    ]).then(function (results) {
      const ndfdOK = results[0].status === 'fulfilled' && results[0].value;
      const mrmsOK = results[1].status === 'fulfilled' && results[1].value;
      if (ndfdOK && mrmsOK) {
        console.log('[DEFNS] Live data loaded (NDFD + MRMS).');
      } else if (ndfdOK || mrmsOK) {
        const which = ndfdOK ? 'MRMS' : 'NDFD';
        console.warn(`[DEFNS] ${which} fetch failed; using mock for that source.`);
      } else {
        console.warn('[DEFNS] No live data; using mock fixtures for both sources.');
      }
    });
  }

  function _fetchInto(url, mockKey) {
    return fetch(url, { cache: 'no-cache' }).then(function (resp) {
      if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
      return resp.json();
    }).then(function (geojson) {
      if (!geojson || !geojson.type || geojson.type !== 'FeatureCollection') {
        throw new Error(`${url}: not a FeatureCollection`);
      }
      MOCK[mockKey] = geojson;        // upgrade the dataset in place
      return true;
    }).catch(function (err) {
      console.warn(`[DEFNS] ${url} fetch failed: ${err.message}`);
      return false;
    });
  }

  // =====================================================================
  // EVENT WIRING
  // =====================================================================
  function _wireEvents() {
    // Detection mode
    els.modeNdfd.addEventListener('change', _onModeChange);
    els.modeMrms.addEventListener('change', _onModeChange);

    // Threshold slider — debounced refresh on input
    let thresholdDebounceTimer = null;
    els.thresholdSlider.addEventListener('input', function () {
      state.threshold = Number(this.value);
      _updateThresholdLabel();
      // Debounce the heavier "recompute alerts" work
      clearTimeout(thresholdDebounceTimer);
      thresholdDebounceTimer = setTimeout(refresh, 120);
    });

    // Window selector (NDFD only)
    els.windowSelect.addEventListener('change', function () {
      state.window = Number(this.value);
      refresh();
    });

    // Layer toggles
    els.layerPrecip.addEventListener('change', function () {
      MAP.setPrecipVisible(this.checked);
    });
    els.layerRadar.addEventListener('change', function () {
      MAP.setRadarVisible(this.checked);
    });
    els.layerAlerts.addEventListener('change', function () {
      MAP.setAlertsVisible(this.checked);
    });
    els.layerReference.addEventListener('change', function () {
      MAP.setReferenceVisible(this.checked);
    });

    // Refresh
    els.manualRefresh.addEventListener('click', _autoRefreshTick);
    els.autoRefreshToggle.addEventListener('change', function () {
      if (this.checked) _startAutoRefresh();
      else              _stopAutoRefresh();
    });

    // When the alerts disclosure opens/closes, Leaflet's view of its
    // container dimensions becomes stale. invalidateSize() forces it to
    // re-measure and redraw tiles cleanly. Use the native 'toggle' event.
    const disclosure = document.getElementById('alerts-disclosure');
    if (disclosure) {
      disclosure.addEventListener('toggle', function () {
        const map = MAP._internalMap && MAP._internalMap();
        if (map) {
          // Wait one frame for CSS to settle before measuring
          requestAnimationFrame(function () { map.invalidateSize(); });
        }
      });
    }
  }

  function _syncControlsFromState() {
    els.thresholdSlider.value = String(state.threshold);
    els.windowSelect.value    = String(state.window);
    _updateThresholdLabel();
    _updateModeUI();
  }

  // =====================================================================
  // MODE SWITCHING
  // =====================================================================
  function _onModeChange() {
    state.mode = els.modeMrms.checked ? 'mrms' : 'ndfd';
    // Apply mode-appropriate default threshold so user isn't stuck on a
    // value that means something different in the other mode.
    state.threshold = state.mode === 'mrms'
      ? CFG.MRMS_DEFAULT_THRESHOLD_CATEGORY
      : CFG.NDFD_DEFAULT_THRESHOLD_CATEGORY;
    els.thresholdSlider.value = String(state.threshold);
    _updateThresholdLabel();
    _updateModeUI();
    refresh();
  }

  function _updateModeUI() {
    if (state.mode === 'mrms') {
      els.windowGroup.hidden    = true;
      els.mrmsWindowNote.hidden = false;
      els.subtitle.textContent =
        'Real-time observed precipitation (MRMS 1-hour radar+gauge ' +
        'accumulation) cross-referenced with the NC Geological Survey ' +
        'channelized debris flow model. Alert raised when any debris ' +
        'flow polygon falls inside an observed precipitation polygon at ' +
        'or above the configured rainfall threshold.';
      els.layerPrecipLabel.textContent = 'Observed precipitation';
    } else {
      els.windowGroup.hidden    = false;
      els.mrmsWindowNote.hidden = true;
      els.subtitle.textContent =
        'Real-time precipitation forecast cross-referenced with the NC ' +
        'Geological Survey channelized debris flow model. Alert raised ' +
        'when any debris flow polygon falls inside a forecast polygon ' +
        'at or above the configured rainfall threshold.';
      els.layerPrecipLabel.textContent = 'Forecast precipitation';
    }
  }

  function _updateThresholdLabel() {
    const lbl = CFG.PRECIP_LABELS[state.threshold] || '--';
    els.thresholdLabel.innerHTML = lbl;
  }

  // =====================================================================
  // REFRESH — recomputes everything from current state + (mock) data
  // =====================================================================
  function refresh() {
    const data = _currentDataset();

    // ---- Map: render precip polygons --------------------------------------
    const precipLabel = state.mode === 'mrms'
      ? 'Observed precipitation (MRMS)'
      : 'Forecast precipitation (NDFD)';
    MAP.setPrecip(data.precip, precipLabel);
    MAP.setPrecipVisible(els.layerPrecip.checked);

    // ---- Compute alerts ---------------------------------------------------
    const result = AL.compute(data.precip, data.debris, state.threshold);

    // ---- Map: render alert polygons ---------------------------------------
    MAP.setAlerts(result.alerts);
    MAP.setAlertsVisible(els.layerAlerts.checked);

    // ---- Update header metrics --------------------------------------------
    _updateHeader(data, result.summary);

    // ---- Update alerts table ----------------------------------------------
    AL.render(result.alerts, els.alertsTbody, els.alertsSummary);

    // ---- Update "last updated" stamp --------------------------------------
    els.lastUpdated.textContent =
      'Last updated: ' + new Date().toLocaleTimeString([], {
        hour: '2-digit', minute: '2-digit'
      });
  }

  function _currentDataset() {
    if (state.mode === 'mrms') {
      return { precip: MOCK.MRMS_OBSERVED, debris: MOCK.DEBRIS_FLOWS };
    }
    return { precip: MOCK.NDFD_FORECAST, debris: MOCK.DEBRIS_FLOWS };
  }

  function _updateHeader(data, summary) {
    if (state.mode === 'mrms') {
      const m = data.precip.meta || {};
      const obs = m.observed_at ? new Date(m.observed_at) : new Date();
      els.metricIssuedTime.textContent =
        obs.toUTCString().slice(17, 22) + ' UTC';
      els.metricIssuedDate.textContent =
        obs.toUTCString().slice(5, 16);
      els.metricWindow.textContent     = '1 hr observed';
      els.metricWindowSub.textContent  =
        'ending ' + obs.toUTCString().slice(17, 22) + ' UTC';
    } else {
      const m = data.precip.meta || {};
      const issued = m.issued ? new Date(m.issued) : new Date();
      const ends   = m.window_end ? new Date(m.window_end) : new Date();
      els.metricIssuedTime.textContent =
        issued.toUTCString().slice(17, 22) + ' UTC';
      els.metricIssuedDate.textContent =
        issued.toUTCString().slice(5, 16);
      els.metricWindow.textContent    = (m.window_hours || state.window) + ' hr';
      els.metricWindowSub.textContent =
        'through ' + ends.toUTCString().slice(17, 22) + ' UTC';
    }

    els.metricThreshold.innerHTML =
      '\u2265 ' + (CFG.PRECIP_LABELS[state.threshold] || '--');
    els.metricThresholdSub.textContent = 'NDFD category ' + state.threshold;

    els.metricFlagged.textContent = String(summary.flagged);
    els.metricFlaggedSub.textContent =
      'of ' + summary.total + ' debris flow polygons';

    // Visual emphasis on the flagged card when there are alerts
    if (summary.flagged > 0) {
      els.metricFlaggedCard.classList.add('has-alerts');
    } else {
      els.metricFlaggedCard.classList.remove('has-alerts');
    }
  }

  // =====================================================================
  // AUTO-REFRESH
  // =====================================================================
  // On the auto-refresh tick (or when the user clicks "Refresh now"), we
  // re-fetch the live data files. The frontend cache-busts via `cache: 'no-cache'`
  // in _fetchInto, so we always see the latest cron output.
  function _autoRefreshTick() {
    _loadLiveData().then(refresh);
  }
  function _startAutoRefresh() {
    _stopAutoRefresh();
    state.autoRefreshTimer = setInterval(_autoRefreshTick, CFG.AUTO_REFRESH_MS);
  }
  function _stopAutoRefresh() {
    if (state.autoRefreshTimer) {
      clearInterval(state.autoRefreshTimer);
      state.autoRefreshTimer = null;
    }
  }

  // =====================================================================
  // ENTRY POINT
  // =====================================================================
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
