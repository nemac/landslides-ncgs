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
    thresholdSourceLabel: $('threshold-source-label'),
    windowSelect:    $('window-select'),
    windowGroup:     $('window-control-group'),
    mrmsWindowNote:  $('mrms-window-note'),

    // Source metadata block (under threshold help text)
    metaSource:      $('meta-source'),
    metaTime:        $('meta-time'),
    metaTimeLabel:   $('meta-time-label'),
    metaExtra:       $('meta-extra'),
    metaExtraLabel:  $('meta-extra-label'),

    // Layer toggles (#2 + #7 reordered)
    layerNdfd:       $('layer-ndfd'),
    layerMrms:       $('layer-mrms'),
    layerRadar:      $('layer-radar'),
    layerAlerts:     $('layer-alerts'),
    layerReference:  $('layer-reference'),

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

    // Alerts table + export
    alertsTbody:    $('alerts-tbody'),
    alertsSummary:  $('alerts-summary'),
    exportCsvBtn:   $('export-csv'),

    // Legend
    legendList:     $('legend-list')
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
    _buildLegend();          // populate 20-category legend
    _wireEvents();
    _syncControlsFromState();
    _updateLegendThreshold();

    _loadLiveData().then(refresh);
    _startAutoRefresh();
  }

  // =====================================================================
  // LEGEND - build once, then update the threshold-arrow marker as needed
  // =====================================================================
  function _buildLegend() {
    if (!els.legendList) return;
    const frag = document.createDocumentFragment();
    for (let cat = 0; cat <= 19; cat++) {
      const li = document.createElement('li');
      li.dataset.cat = String(cat);

      const arrow = document.createElement('span');
      arrow.className = 'legend-arrow';
      arrow.setAttribute('aria-hidden', 'true');
      // text placeholder; updated by _updateLegendThreshold
      arrow.textContent = '';

      const swatch = document.createElement('span');
      swatch.className = 'legend-swatch';
      swatch.setAttribute('aria-hidden', 'true');
      swatch.style.background = CFG.PRECIP_COLORS[cat] || '#888';

      const text = document.createElement('span');
      text.className = 'legend-text';
      text.textContent = `cat ${cat} \u00b7 ${CFG.PRECIP_LABELS[cat]}`;

      li.appendChild(arrow);
      li.appendChild(swatch);
      li.appendChild(text);
      frag.appendChild(li);
    }
    els.legendList.innerHTML = '';
    els.legendList.appendChild(frag);
  }

  function _updateLegendThreshold() {
    if (!els.legendList) return;
    const lis = els.legendList.querySelectorAll('li');
    lis.forEach(function (li) {
      const cat = Number(li.dataset.cat);
      const arrow = li.querySelector('.legend-arrow');
      li.classList.toggle('at-or-above', cat >= state.threshold);
      li.classList.toggle('current',     cat === state.threshold);
      if (arrow) arrow.textContent = (cat === state.threshold) ? '\u25B6' : '';
    });
  }

  // =====================================================================
  // EVENT WIRING
  // =====================================================================
  function _wireEvents() {
    els.modeNdfd.addEventListener('change', _onModeChange);
    els.modeMrms.addEventListener('change', _onModeChange);

    // Threshold slider - debounced refresh
    let thresholdDebounceTimer = null;
    els.thresholdSlider.addEventListener('input', function () {
      state.threshold = Number(this.value);
      _updateThresholdLabel();
      _updateLegendThreshold();
      clearTimeout(thresholdDebounceTimer);
      thresholdDebounceTimer = setTimeout(refresh, 120);
    });

    els.windowSelect.addEventListener('change', function () {
      state.window = Number(this.value);
      refresh();
    });

    // Layer toggles (new structure - separate NDFD and MRMS visibility)
    els.layerNdfd.addEventListener('change', function () {
      MAP.setForecastVisible(this.checked);
    });
    els.layerMrms.addEventListener('change', function () {
      MAP.setObservedVisible(this.checked);
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

    // CSV export (#11)
    if (els.exportCsvBtn) {
      els.exportCsvBtn.addEventListener('click', _exportCsv);
    }

    // Alerts disclosure toggle - invalidate map size so tiles fill the new space
    const disclosure = document.getElementById('alerts-disclosure');
    if (disclosure) {
      disclosure.addEventListener('toggle', function () {
        const map = MAP._internalMap && MAP._internalMap();
        if (map) requestAnimationFrame(function () { map.invalidateSize(); });
      });
    }
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
    state.threshold = state.mode === 'mrms'
      ? CFG.MRMS_DEFAULT_THRESHOLD_CATEGORY
      : CFG.NDFD_DEFAULT_THRESHOLD_CATEGORY;
    els.thresholdSlider.value = String(state.threshold);
    _updateThresholdLabel();
    _updateLegendThreshold();
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
      els.thresholdSourceLabel.textContent = '(MRMS)';
    } else {
      els.windowGroup.hidden    = false;
      els.mrmsWindowNote.hidden = true;
      els.subtitle.textContent =
        'Real-time precipitation forecast cross-referenced with the NC ' +
        'Geological Survey channelized debris flow model. Alert raised ' +
        'when any debris flow polygon falls inside a forecast polygon ' +
        'at or above the configured rainfall threshold.';
      els.thresholdSourceLabel.textContent = '(NDFD)';
    }
  }

  function _updateThresholdLabel() {
    const lbl = CFG.PRECIP_LABELS[state.threshold] || '--';
    els.thresholdLabel.innerHTML = lbl;
  }

  // =====================================================================
  // REFRESH — recomputes everything from current state + loaded data
  // =====================================================================
  function refresh() {
    // ---- Render BOTH precip layers (independent of detection mode) ------
    // The user can toggle visibility of each via the sidebar; we always
    // load both into the map so the toggles work instantly.
    MAP.setForecast(MOCK.NDFD_FORECAST);
    MAP.setForecastVisible(els.layerNdfd.checked);

    MAP.setObserved(MOCK.MRMS_OBSERVED);
    MAP.setObservedVisible(els.layerMrms.checked);

    // ---- Pick the active dataset for alert computation ------------------
    const active = state.mode === 'mrms'
      ? MOCK.MRMS_OBSERVED
      : MOCK.NDFD_FORECAST;

    const result = AL.compute(active, MOCK.DEBRIS_FLOWS, state.threshold);

    // Stash the latest results for CSV export
    state.lastAlerts = result.alerts;
    state.lastCtx    = _buildSourceCtx(active);

    // ---- Map: render alert polygons -------------------------------------
    MAP.setAlerts(result.alerts);
    MAP.setAlertsVisible(els.layerAlerts.checked);

    // ---- Header metrics --------------------------------------------------
    _updateHeader(active, result.summary);

    // ---- Source metadata block (#6) -------------------------------------
    _updateSourceMeta(active);

    // ---- Alerts table ----------------------------------------------------
    AL.render(result.alerts, els.alertsTbody, els.alertsSummary, state.lastCtx);

    // Disable CSV button when there's nothing to export
    if (els.exportCsvBtn) {
      els.exportCsvBtn.disabled = !(result.alerts.features &&
                                    result.alerts.features.length);
    }

    // ---- "Last updated" stamp -------------------------------------------
    els.lastUpdated.textContent =
      'Last updated: ' + new Date().toLocaleTimeString([], {
        hour: '2-digit', minute: '2-digit'
      });
  }

  // -- helpers consumed by refresh ----------------------------------------

  function _buildSourceCtx(activeFC) {
    const m = (activeFC && activeFC.meta) || {};
    const isoTime = state.mode === 'mrms' ? m.observed_at : m.issued;
    let display = '--';
    if (isoTime) {
      const d = new Date(isoTime);
      display = d.toUTCString().slice(17, 22) + ' UTC ' +
                d.toUTCString().slice(5, 11);
    }
    return {
      sourceLabel:  state.mode === 'mrms' ? 'MRMS' : 'NDFD',
      timestamp:    display,
      timestampISO: isoTime || ''
    };
  }

  function _updateHeader(activeFC, summary) {
    const m = activeFC.meta || {};

    if (state.mode === 'mrms') {
      const obs = m.observed_at ? new Date(m.observed_at) : new Date();
      els.metricIssuedTime.textContent =
        obs.toUTCString().slice(17, 22) + ' UTC';
      els.metricIssuedDate.textContent =
        obs.toUTCString().slice(5, 16);
      els.metricWindow.textContent     = '1 hr observed';
      els.metricWindowSub.textContent  =
        'ending ' + obs.toUTCString().slice(17, 22) + ' UTC';
    } else {
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

    if (summary.flagged > 0) {
      els.metricFlaggedCard.classList.add('has-alerts');
    } else {
      els.metricFlaggedCard.classList.remove('has-alerts');
    }
  }

  function _updateSourceMeta(activeFC) {
    const m = (activeFC && activeFC.meta) || {};

    els.metaSource.textContent = m.source || '--';

    if (state.mode === 'mrms') {
      els.metaTimeLabel.textContent = 'Observed';
      const obs = m.observed_at ? new Date(m.observed_at) : null;
      els.metaTime.textContent = obs
        ? obs.toUTCString().slice(5, 22) + ' UTC'
        : '--';

      // Extra row for MRMS: max observed inches
      els.metaExtraLabel.hidden = false;
      els.metaExtra.hidden = false;
      els.metaExtraLabel.textContent = 'Max observed';
      if (m.max_inches != null) {
        const min_ago = m.minutes_ago != null
          ? ` (${Math.round(m.minutes_ago)} min ago)`
          : '';
        els.metaExtra.textContent = m.max_inches.toFixed(2) + '\u2033' + min_ago;
      } else {
        els.metaExtra.textContent = '--';
      }
    } else {
      els.metaTimeLabel.textContent = 'Issued';
      const issued = m.issued ? new Date(m.issued) : null;
      els.metaTime.textContent = issued
        ? issued.toUTCString().slice(5, 22) + ' UTC'
        : '--';

      // Extra row for NDFD: window end
      els.metaExtraLabel.hidden = false;
      els.metaExtra.hidden = false;
      els.metaExtraLabel.textContent = 'Window end';
      const ends = m.window_end ? new Date(m.window_end) : null;
      els.metaExtra.textContent = ends
        ? ends.toUTCString().slice(5, 22) + ' UTC'
        : '--';
    }
  }

  // =====================================================================
  // CSV EXPORT (#11)
  // =====================================================================
  function _exportCsv() {
    if (!state.lastAlerts || !state.lastAlerts.features
        || !state.lastAlerts.features.length) {
      return;
    }

    const csv = AL.toCSV(state.lastAlerts, state.lastCtx);
    const ts  = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `defns-alerts-${ts}Z.csv`;

    // Use a Blob + ObjectURL so we don't have to base64-encode large CSVs
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url  = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
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
