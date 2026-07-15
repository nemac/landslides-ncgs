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
    modeHistorical:  $('mode-historical'),
    historicalSubControls: $('historical-sub-controls'),
    eventSelect:     $('event-select'),
    eventDescription:$('event-description'),
    hindcastBanner:  $('hindcast-banner'),
    hindcastBannerDetail: $('hindcast-banner-detail'),
    thresholdSlider: $('threshold-slider'),
    thresholdLabel:  $('threshold-readout-label'),
    thresholdSourceLabel: $('threshold-source-label'),
    windowSelect:    $('window-select'),
    windowGroup:     $('window-control-group'),
    windowLabel:     $('window-label'),

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
    layerParcels:    $('layer-parcels'),
    layerBuildings:  $('layer-buildings'),
    parcelsZoomHint: $('parcels-zoom-hint'),

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
    legendList:     $('legend-list'),

    // Loading indicator (Phase B)
    loadingIndicator: $('loading-indicator')
  };

  // ---- State --------------------------------------------------------------
  const state = {
    mode:      'ndfd',                                  // 'ndfd' | 'mrms' | 'historical'
    threshold: CFG.NDFD_DEFAULT_THRESHOLD_CATEGORY,     // 0..19
    window:    CFG.NDFD_DEFAULT_WINDOW_HOURS,           // hours, semantics depends on mode
    autoRefreshTimer: null,
    // Track which window's data is currently loaded into the MOCK keys.
    // Lets us skip re-fetching when the user toggles modes and the
    // already-loaded window matches the new mode's selection.
    loadedWindows: { ndfd: null, mrms: null },
  };

  // Per-mode window dropdown configuration. NDFD is forward-looking
  // (forecast); MRMS is backward-looking (observation). The min option
  // differs (NDFD's smallest meaningful window is 12h because the
  // service publishes 6-hour blocks; MRMS pre-sums every hour so 1h
  // is a useful real-time view). Historical mode hides the dropdown
  // because each event has a fixed accumulation window.
  //
  // MRMS window set is [1, 24, 72] - the subset that IEM actually
  // archives. NSSL produces 12H and 48H accumulations but IEM doesn't
  // mirror them; semantically 1H/24H/72H cover the useful range anyway
  // (now / last day / recent storm activity).
  const WINDOW_OPTIONS_BY_MODE = {
    ndfd: {
      options: [12, 24, 48, 72],
      default: 12,
      label:   'Forecast window',
    },
    mrms: {
      options: [1, 24, 72],
      default: 1,
      label:   'Observation window',
    },
  };

  // =====================================================================
  // INITIALIZATION
  // =====================================================================
  function init() {
    MAP.init();
    _buildLegend();          // populate 20-category legend
    _wireEvents();

    // Populate the window dropdown for the initial mode BEFORE
    // _syncControlsFromState() so the dropdown has the right options
    // when state.window gets reflected back into the UI.
    _populateWindowSelect(state.mode);

    _syncControlsFromState();
    _updateLegendThreshold();

    // Load events manifest in parallel with live data. The manifest is
    // small (~1 KB) so this doesn't slow page load. If it fails (file
    // doesn't exist yet), _loadEventsManifest disables the historical
    // radio gracefully.
    //
    // _loadLiveDataInitial preloads BOTH modes' default windows so
    // mode-switching is instant (no fetch lag the first time the user
    // toggles to MRMS). Switching to a non-default window still requires
    // an on-demand fetch via _loadLiveData().
    Promise.all([
      _loadLiveDataInitial(),
      _loadEventsManifest()
    ]).then(refresh);

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
    els.modeHistorical.addEventListener('change', _onModeChange);

    // Event dropdown - reload data when user picks a different event
    if (els.eventSelect) {
      els.eventSelect.addEventListener('change', _onEventChange);
    }

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
      // _loadLiveData() is window-aware: fetches the matching per-window
      // files for the active mode, then refresh() re-renders with the new
      // data. No-op if the requested window is already cached.
      _loadLiveData().then(refresh);
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
      const turningOn = this.checked;
      if (turningOn) _setLoading(true);
      Promise.resolve(MAP.setReferenceVisible(turningOn)).then(function () {
        if (turningOn) _setLoading(false);
      });
    });

    // New reference-layer toggles (post-launch additions): NC parcels and
    // Overture building footprints. Both are visual reference layers
    // separate from the alert pipeline; toggling them does not require
    // re-running the loading indicator since neither blocks on data we
    // fetch ourselves (parcels fetch incrementally per pan/zoom; PMTiles
    // stream from Overture's CDN).
    if (els.layerParcels) {
      els.layerParcels.addEventListener('change', function () {
        MAP.setParcelsVisible(this.checked);
      });
    }
    if (els.layerBuildings) {
      els.layerBuildings.addEventListener('change', function () {
        MAP.setBuildingsVisible(this.checked);
      });
    }

    // Keep the "zoom in to load" hint accurate for the parcels toggle.
    // The parcels layer only fetches at zoom >= CFG.NCONEMAP_PARCELS_MIN_ZOOM;
    // below that, even with the toggle checked the user sees nothing.
    // Show the hint whenever we're below the min zoom; hide it when zoomed in.
    _wireParcelsZoomHint();

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
  // LIVE DATA FETCH (Phase 3a + Phase B)
  // =====================================================================
  // We fetch four files in parallel:
  //   forecast.geojson      NDFD precip (visualization)
  //   observed.geojson      MRMS precip (visualization)
  //   flagged_ndfd.geojson  Pre-computed alerts (server-side intersection)
  //   flagged_mrms.geojson  Pre-computed alerts (server-side intersection)
  //
  // The MOCK module is mutated in-place when fetches succeed, so refresh()
  // transparently uses live data wherever it's available.
  // =====================================================================
  // Per-window file loaders.
  //
  // After our 2026-05-28 multi-window refactor, refresh.py writes
  // window-suffixed files like forecast_12h.geojson, observed_24h.geojson,
  // flagged_ndfd_72h.geojson, etc. The frontend keeps the most recently
  // loaded window of each mode in the MOCK keys (NDFD_FORECAST, etc.) and
  // tracks which window that is in state.loadedWindows.
  //
  // On page init we preload the DEFAULT window for both modes (NDFD 12h
  // and MRMS 1h) so mode-switching is instant. When the user picks a
  // different window from the dropdown, _loadLiveData() fetches just
  // that window's files into the same MOCK keys.
  // =====================================================================
  function _loadLiveDataInitial() {
    _setLoading(true);
    return Promise.allSettled([
      _fetchInto('data/forecast_12h.geojson',     'NDFD_FORECAST'),
      _fetchInto('data/observed_1h.geojson',      'MRMS_OBSERVED'),
      _fetchInto('data/flagged_ndfd_12h.geojson', 'FLAGGED_NDFD'),
      _fetchInto('data/flagged_mrms_1h.geojson',  'FLAGGED_MRMS')
    ]).then(function (results) {
      const labels = ['NDFD 12h', 'MRMS 1h', 'NDFD 12h flagged', 'MRMS 1h flagged'];
      const okCount = results.filter(r => r.status === 'fulfilled' && r.value).length;
      console.log(`[DEFNS] Initial live data: ${okCount}/4 files loaded.`);
      results.forEach(function (r, i) {
        if (r.status !== 'fulfilled' || !r.value) {
          console.warn(`[DEFNS] ${labels[i]} failed; falling back to mock.`);
        }
      });
      // Mark these default windows as loaded so we don't re-fetch them
      // when the user lands on the default mode/window combination.
      state.loadedWindows.ndfd = 12;
      state.loadedWindows.mrms = 1;
      _setLoading(false);
    }).catch(function (err) {
      _setLoading(false);
      console.error('[DEFNS] _loadLiveDataInitial crashed:', err);
    });
  }

  function _loadLiveData() {
    // Fetch the current mode's selected window IF it differs from what's
    // already loaded. No-op if the requested window is cached.
    if (state.mode === 'historical') return Promise.resolve();

    const target = state.window;
    if (state.mode === 'ndfd' && state.loadedWindows.ndfd === target) {
      return Promise.resolve();
    }
    if (state.mode === 'mrms' && state.loadedWindows.mrms === target) {
      return Promise.resolve();
    }

    _setLoading(true);
    let promises;
    if (state.mode === 'ndfd') {
      promises = [
        _fetchInto(`data/forecast_${target}h.geojson`,     'NDFD_FORECAST'),
        _fetchInto(`data/flagged_ndfd_${target}h.geojson`, 'FLAGGED_NDFD'),
      ];
    } else {  // mrms
      promises = [
        _fetchInto(`data/observed_${target}h.geojson`,     'MRMS_OBSERVED'),
        _fetchInto(`data/flagged_mrms_${target}h.geojson`, 'FLAGGED_MRMS'),
      ];
    }

    return Promise.allSettled(promises).then(function (results) {
      _setLoading(false);
      const okCount = results.filter(r => r.status === 'fulfilled' && r.value).length;
      console.log(`[DEFNS] ${state.mode.toUpperCase()} ${target}h: ${okCount}/2 files loaded.`);
      // Mark loaded even if some files failed - we don't want infinite
      // retry loops on missing files. The MOCK keys will hold whatever
      // succeeded plus stale data for whatever didn't.
      if (state.mode === 'ndfd') state.loadedWindows.ndfd = target;
      else if (state.mode === 'mrms') state.loadedWindows.mrms = target;
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
      MOCK[mockKey] = geojson;
      return true;
    }).catch(function (err) {
      console.warn(`[DEFNS] ${url} fetch failed: ${err.message}`);
      return false;
    });
  }

  // =====================================================================
  // LOADING INDICATOR
  // =====================================================================
  // Reference-counted so multiple overlapping loads (e.g. page-init data
  // fetch + NCGS reference toggle) compose correctly. The spinner only
  // hides when every outstanding _setLoading(true) has been matched by a
  // _setLoading(false). Floors at zero so spurious off-calls can't push
  // the counter negative.
  let _loadingCount = 0;
  function _setLoading(isLoading) {
    if (!els.loadingIndicator) return;
    _loadingCount += isLoading ? 1 : -1;
    if (_loadingCount < 0) _loadingCount = 0;
    const busy = _loadingCount > 0;
    els.loadingIndicator.hidden = !busy;
    els.loadingIndicator.setAttribute('aria-busy', busy ? 'true' : 'false');
  }

  function _syncControlsFromState() {
    els.thresholdSlider.value = String(state.threshold);
    els.windowSelect.value    = String(state.window);
    _updateThresholdLabel();
    _updateModeUI();
  }

  // Show or hide the "zoom in to load" hint next to the NC Parcels toggle
  // based on current map zoom. The hint is always present in the DOM (for
  // screen-reader stability) but visually hidden via the .is-hidden class
  // when not relevant. Updated on every zoomend so users see real-time
  // feedback as they zoom in or out.
  function _wireParcelsZoomHint() {
    if (!els.parcelsZoomHint || !window.DEFNS_MAP) return;
    const map = window.DEFNS_MAP._internalMap();
    if (!map) return;

    const minZoom = (window.DEFNS_CONFIG &&
                     window.DEFNS_CONFIG.NCONEMAP_PARCELS_MIN_ZOOM) || 14;

    function update() {
      const tooFarOut = map.getZoom() < minZoom;
      els.parcelsZoomHint.classList.toggle('is-hidden', !tooFarOut);
    }
    map.on('zoomend', update);
    update();   // initial state
  }

  // =====================================================================
  // MODE SWITCHING
  // =====================================================================
  function _onModeChange() {
    if (els.modeMrms.checked) {
      state.mode = 'mrms';
      state.threshold = CFG.MRMS_DEFAULT_THRESHOLD_CATEGORY;
    } else if (els.modeHistorical.checked) {
      state.mode = 'historical';
      // Use the MRMS default threshold for historical - both are observed
      // precipitation accumulations, similar ranges of interest.
      state.threshold = CFG.MRMS_DEFAULT_THRESHOLD_CATEGORY;
    } else {
      state.mode = 'ndfd';
      state.threshold = CFG.NDFD_DEFAULT_THRESHOLD_CATEGORY;
    }
    els.thresholdSlider.value = String(state.threshold);
    _updateThresholdLabel();
    _updateLegendThreshold();
    _updateModeUI();

    if (state.mode === 'historical') {
      // Lazy-load the currently selected event's files, then refresh.
      _loadSelectedEvent().then(refresh);
    } else {
      // _populateWindowSelect (called by _updateModeUI above) already
      // reset state.window to the new mode's default. _loadLiveData will
      // fetch that window if it isn't already cached - usually it IS
      // cached because _loadLiveDataInitial preloaded both defaults at
      // page init.
      _loadLiveData().then(refresh);
    }
  }

  function _updateModeUI() {
    const isHistorical = state.mode === 'historical';
    const isMrms       = state.mode === 'mrms';

    // Show/hide the historical event sub-controls
    if (els.historicalSubControls) {
      els.historicalSubControls.hidden = !isHistorical;
    }
    // Show/hide the hindcast banner
    if (els.hindcastBanner) {
      els.hindcastBanner.hidden = !isHistorical;
    }

    // Populate the window dropdown for the new mode (also handles hiding
    // for historical mode). This sets state.window to the mode's default,
    // which we want on mode switch - the user can pick a different window
    // afterward.
    _populateWindowSelect(state.mode);

    // Mode-specific badge on the threshold readout. The subtitle itself is
    // now static (set once in index.html) since the new copy describes the
    // dashboard as a whole rather than per-mode behavior.
    if (isMrms) {
      els.thresholdSourceLabel.textContent = '(MRMS)';
    } else if (isHistorical) {
      els.thresholdSourceLabel.textContent = '(historical)';
    } else {
      els.thresholdSourceLabel.textContent = '(NDFD)';
    }
  }

  // Build the window dropdown for the current mode. Called from
  // _updateModeUI() on mode change, and once from init().
  //
  // - Historical mode: hides the dropdown entirely (each event has a
  //   fixed accumulation window baked into its precip file).
  // - NDFD / MRMS modes: shows the dropdown with mode-appropriate options
  //   and label, and resets state.window to that mode's default. The
  //   reset is intentional - mode switching is a deliberate context
  //   change, so starting at the default is the cleanest UX.
  function _populateWindowSelect(mode) {
    const cfg = WINDOW_OPTIONS_BY_MODE[mode];
    if (!cfg) {
      els.windowGroup.hidden = true;
      return;
    }
    els.windowGroup.hidden = false;
    els.windowLabel.textContent = cfg.label;

    // Rebuild options to match the new mode's set
    els.windowSelect.innerHTML = '';
    cfg.options.forEach(function (hrs) {
      const opt = document.createElement('option');
      opt.value = String(hrs);
      opt.textContent = hrs + ' hour' + (hrs === 1 ? '' : 's');
      if (hrs === cfg.default) opt.selected = true;
      els.windowSelect.appendChild(opt);
    });
    state.window = cfg.default;
  }

  // =====================================================================
  // HISTORICAL EVENT HANDLING
  // =====================================================================
  // Events are listed in data/historical/events.json (written by
  // refresh.py --hindcast). Each entry references its precip + flagged
  // files. We populate the dropdown from this manifest, and load the
  // selected event's files on demand.
  function _loadEventsManifest() {
    return fetch('data/historical/events.json', { cache: 'no-cache' })
      .then(function (r) {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(function (manifest) {
        const events = (manifest && manifest.events) || [];
        state.events = events;
        _populateEventDropdown(events);
        if (events.length > 0 && els.eventSelect) {
          els.eventSelect.value = events[0].id;
          _updateEventDescription(events[0]);
        }
      })
      .catch(function (err) {
        console.warn('[DEFNS] No historical events manifest:', err.message);
        state.events = [];
        if (els.eventSelect) {
          els.eventSelect.innerHTML =
            '<option value="">No events available</option>';
        }
        // Disable the historical radio if no events exist
        if (els.modeHistorical) {
          els.modeHistorical.disabled = true;
          const label = document.querySelector('label[for="mode-historical"]');
          if (label) label.style.opacity = '0.5';
        }
      });
  }

  function _populateEventDropdown(events) {
    if (!els.eventSelect) return;
    els.eventSelect.innerHTML = '';
    if (events.length === 0) {
      els.eventSelect.innerHTML =
        '<option value="">No events available</option>';
      return;
    }
    events.forEach(function (ev) {
      const opt = document.createElement('option');
      opt.value = ev.id;
      opt.textContent = `${ev.name} (${ev.date_label})`;
      els.eventSelect.appendChild(opt);
    });
  }

  function _updateEventDescription(event) {
    if (els.eventDescription && event) {
      els.eventDescription.textContent = event.description || '';
    }
    if (els.hindcastBannerDetail && event) {
      els.hindcastBannerDetail.textContent =
        `${event.name} (${event.date_label})`;
    }
  }

  function _getSelectedEvent() {
    if (!els.eventSelect || !state.events) return null;
    const id = els.eventSelect.value;
    return state.events.find(function (e) { return e.id === id; }) || null;
  }

  function _onEventChange() {
    const ev = _getSelectedEvent();
    if (!ev) return;
    _updateEventDescription(ev);
    _loadSelectedEvent().then(refresh);
  }

  function _loadSelectedEvent() {
    const ev = _getSelectedEvent();
    if (!ev) return Promise.resolve();

    _setLoading(true);
    return Promise.allSettled([
      _fetchInto('data/' + ev.precip_file,  'HISTORICAL_PRECIP'),
      _fetchInto('data/' + ev.flagged_file, 'HISTORICAL_FLAGGED')
    ]).then(function (results) {
      _setLoading(false);
      const okCount = results.filter(r =>
        r.status === 'fulfilled' && r.value).length;
      console.log(`[DEFNS] Historical event "${ev.id}": ${okCount}/2 files loaded.`);
    });
  }

  function _updateThresholdLabel() {
    // Show just the lower bound (e.g. "5.00\u2033") not the range
    // (e.g. "5.00-6.00\u2033"), since the threshold means "this category OR
    // higher" - so "at or above 5 inches" is what users want to see.
    const lbl = CFG.formatThresholdInches(state.threshold) || '--';
    els.thresholdLabel.innerHTML = lbl;
  }

  // =====================================================================
  // REFRESH - recomputes everything from current state + loaded data
  //
  // Phase B: alerts are pre-computed by refresh.py and shipped as
  // flagged_ndfd.geojson and flagged_mrms.geojson. Each feature has a
  // `max_category` property. We filter client-side by:
  //     feature.properties.max_category >= state.threshold
  // No turf intersection on the client - all spatial work is done by
  // refresh.py in geopandas, which is orders of magnitude faster than
  // doing it in JS for 228k debris flow polygons.
  // =====================================================================
  function refresh() {
    const isHistorical = state.mode === 'historical';

    // ---- Render precip layers --------------------------------------------
    // In live modes (NDFD/MRMS), show both live layers per user toggles.
    // In historical mode, hide live layers and show the historical layer.
    if (isHistorical) {
      MAP.setForecast(null);                          // clear NDFD
      MAP.setObserved(MOCK.HISTORICAL_PRECIP);        // reuse observed pane
      MAP.setObservedVisible(true);                   // always show in hindcast
    } else {
      MAP.setForecast(MOCK.NDFD_FORECAST);
      MAP.setForecastVisible(els.layerNdfd.checked);
      MAP.setObserved(MOCK.MRMS_OBSERVED);
      MAP.setObservedVisible(els.layerMrms.checked);
    }

    // ---- Pick the active precip + flagged dataset for the current mode --
    let activePrecip, activeFlagged;
    if (isHistorical) {
      activePrecip  = MOCK.HISTORICAL_PRECIP;
      activeFlagged = MOCK.HISTORICAL_FLAGGED;
    } else if (state.mode === 'mrms') {
      activePrecip  = MOCK.MRMS_OBSERVED;
      activeFlagged = MOCK.FLAGGED_MRMS;
    } else {
      activePrecip  = MOCK.NDFD_FORECAST;
      activeFlagged = MOCK.FLAGGED_NDFD;
    }

    // ---- Filter pre-computed flagged data by threshold -------------------
    let alertsFC;
    let totalCandidates = 0;
    let totalDebris     = 0;

    if (activeFlagged && activeFlagged.features) {
      // Live mode: server pre-computed. Filter by max_category client-side.
      totalCandidates = activeFlagged.features.length;
      totalDebris     = (activeFlagged.meta && activeFlagged.meta.n_debris)
                        || totalCandidates;
      const matched = activeFlagged.features.filter(function (f) {
        return Number(f.properties.max_category) >= state.threshold;
      });
      alertsFC = { type: 'FeatureCollection', features: matched };
    } else {
      // Fallback mode: no flagged file present. Use legacy client-side
      // turf intersection against the mock 8-rectangle debris flows.
      // This keeps the dashboard testable before refresh.py has run.
      const result = AL.compute(activePrecip, MOCK.DEBRIS_FLOWS, state.threshold);
      alertsFC = result.alerts;
      totalDebris = result.summary.total;
    }

    // ---- Stash for CSV export + click-to-zoom ---------------------------
    state.lastAlerts = alertsFC;
    state.lastCtx    = _buildSourceCtx(activePrecip);

    // ---- Map: render alert polygons --------------------------------------
    MAP.setAlerts(alertsFC);
    MAP.setAlertsVisible(els.layerAlerts.checked);

    // ---- Header metrics --------------------------------------------------
    _updateHeader(activePrecip, {
      flagged: alertsFC.features.length,
      total:   totalDebris,
      maxCategory: _maxCategoryIn(alertsFC)
    });

    // ---- Source metadata block ------------------------------------------
    _updateSourceMeta(activePrecip);

    // ---- Alerts table ----------------------------------------------------
    // Normalize property name: pre-computed flagged data uses `max_category`
    // (a property of the polygon itself), while client-side fallback uses
    // `precip_category` (a property of the intersection event). The table
    // renderer reads `precip_category` for the swatch and label. Bridge:
    alertsFC.features.forEach(function (f) {
      const p = f.properties;
      if (p.max_category != null && p.precip_category == null) {
        p.precip_category = p.max_category;
        p.precip_label    = CFG.PRECIP_LABELS[p.max_category] || null;
      }
    });

    AL.render(alertsFC, els.alertsTbody, els.alertsSummary, state.lastCtx);
    _wireRowClicks();        // (re-wire after every render - new <tr> each time)

    if (els.exportCsvBtn) {
      els.exportCsvBtn.disabled = !(alertsFC.features && alertsFC.features.length);
    }

    els.lastUpdated.textContent =
      'Last updated: ' + new Date().toLocaleTimeString([], {
        hour: '2-digit', minute: '2-digit'
      });
  }

  function _maxCategoryIn(fc) {
    if (!fc || !fc.features || !fc.features.length) return null;
    let max = -1;
    for (const f of fc.features) {
      const c = Number(f.properties.precip_category != null
                       ? f.properties.precip_category
                       : f.properties.max_category);
      if (c > max) max = c;
    }
    return max >= 0 ? max : null;
  }

  // =====================================================================
  // CLICK-TO-ZOOM (#10)
  // =====================================================================
  // Each row in the alerts table corresponds to one flagged polygon.
  // Clicking the row zooms the map to that polygon's extent.
  function _wireRowClicks() {
    if (!els.alertsTbody || !state.lastAlerts) return;
    const rows = els.alertsTbody.querySelectorAll('tr[data-objectid]');
    rows.forEach(function (tr) {
      const oid = tr.dataset.objectid;
      if (!oid) return;
      tr.classList.add('row-clickable');
      tr.tabIndex = 0;
      tr.setAttribute('role', 'button');
      tr.setAttribute('aria-label', `Zoom map to polygon ${oid}`);
      tr.addEventListener('click', function () { _zoomToObjectId(oid); });
      tr.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          _zoomToObjectId(oid);
        }
      });
    });
  }

  function _zoomToObjectId(objectid) {
    if (!state.lastAlerts) return;
    const match = state.lastAlerts.features.find(function (f) {
      return String(f.properties.OBJECTID) === String(objectid);
    });
    if (!match || !match.geometry) return;
    const lmap = MAP._internalMap && MAP._internalMap();
    if (!lmap) return;
    try {
      const bbox = turf.bbox(match);   // [minX, minY, maxX, maxY]
      const bounds = [[bbox[1], bbox[0]], [bbox[3], bbox[2]]];
      lmap.fitBounds(bounds, { padding: [60, 60], maxZoom: 15 });
    } catch (e) {
      console.warn('[DEFNS] Could not zoom to polygon:', e);
    }
  }

  // -- helpers consumed by refresh ----------------------------------------

  function _buildSourceCtx(activeFC) {
    const m = (activeFC && activeFC.meta) || {};
    let isoTime, display, sourceLabel, windowLabel;

    if (state.mode === 'historical') {
      sourceLabel = 'HIST';
      display = m.date_label || m.end_date || '--';
      isoTime = m.end_date || '';
      // Historical events are pre-summed accumulations. Use the actual
      // accumulation period from the file meta.
      windowLabel = (m.accumulation_days != null)
        ? `${m.accumulation_days}-day accumulation`
        : 'accumulation';
    } else if (state.mode === 'mrms') {
      sourceLabel = 'MRMS';
      isoTime = m.observed_at;
      display = isoTime
        ? new Date(isoTime).toUTCString().slice(17, 22) + ' UTC ' +
          new Date(isoTime).toUTCString().slice(5, 11)
        : '--';
      // MRMS supports multiple observation windows (1, 24, 72 hours after
      // the 2026-05-28 multi-window refactor). Read from file meta to
      // get the window that was actually generated; fall back to UI state
      // if meta is missing for some reason.
      const hrs = m.window_hours != null ? m.window_hours : state.window;
      windowLabel = `${hrs} hr observed`;
    } else {
      sourceLabel = 'NDFD';
      isoTime = m.issued;
      display = isoTime
        ? new Date(isoTime).toUTCString().slice(17, 22) + ' UTC ' +
          new Date(isoTime).toUTCString().slice(5, 11)
        : '--';
      // NDFD has a configurable forecast window. Prefer the value from
      // file meta (what the refresh actually used) over the UI state.
      const hrs = m.window_hours != null ? m.window_hours : state.window;
      windowLabel = `${hrs} hr forecast`;
    }

    // Threshold label: "\u2265 5.00\u2033" - same value for every row,
    // included in context once so render() can paint the column.
    const thresholdLabel = '\u2265 ' +
      (CFG.formatThresholdInches(state.threshold) || '--');

    return {
      sourceLabel,
      timestamp:     display,
      timestampISO:  isoTime || '',
      windowLabel,
      thresholdLabel,
    };
  }

  // Format a Date as "HH:MM UTC, H:MM AM/PM ET" combined display.
  //
  // UTC is the source-of-truth for weather data timestamps - upstream
  // NDFD forecasts and MRMS observations publish in UTC, and keeping it
  // visible lets meteorologists cross-reference the raw source.
  //
  // ET (Eastern Time) is what stakeholders in North Carolina actually
  // read on their wall clock. "ET" is the umbrella term - technically
  // it's EDT (UTC-4) during Daylight Saving and EST (UTC-5) the rest of
  // the year, but "ET" is correct year-round without needing users to
  // know which flavor is currently in effect. AM/PM is used because
  // 24-hour time isn't the everyday US format - "3:51 PM" is instant
  // recognition, "15:51" is a mental-translation step.
  //
  // The formatter uses timeZone: America/New_York which automatically
  // applies whichever offset (EDT or EST) is in effect for the date
  // shown - so it always matches the wall clock. We append " ET"
  // ourselves rather than using timeZoneName so the label stays "ET"
  // regardless of DST state.
  const _ET_FORMATTER = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour:     'numeric',
    minute:   '2-digit',
    hour12:   true,
  });
  function _formatTimeUtcAndEt(date) {
    const utcPart = date.toUTCString().slice(17, 22) + ' UTC';
    // e.g. "3:51 PM" - Intl.DateTimeFormat handles AM/PM formatting
    // and single-digit hours (no leading zero) automatically.
    const etTime = _ET_FORMATTER.format(date);
    return utcPart + ', ' + etTime + ' ET';
  }

  function _updateHeader(activeFC, summary) {
    const m = activeFC.meta || {};

    if (state.mode === 'historical') {
      // The "Issued"/"Window" metric cards repurpose to show event identity
      els.metricIssuedTime.textContent = m.end_date || '--';
      els.metricIssuedDate.textContent = m.event_name || 'Historical';
      els.metricWindow.textContent     =
        (m.accumulation_days || '?') + ' days';
      els.metricWindowSub.textContent  = 'accumulation';
    } else if (state.mode === 'mrms') {
      const obs = m.observed_at ? new Date(m.observed_at) : new Date();
      els.metricIssuedTime.textContent = _formatTimeUtcAndEt(obs);
      els.metricIssuedDate.textContent =
        obs.toUTCString().slice(5, 16);
      els.metricWindow.textContent     =
        (m.window_hours || state.window) + ' hr';
      els.metricWindowSub.textContent  =
        'ending ' + obs.toUTCString().slice(17, 22) + ' UTC';
    } else {
      const issued = m.issued ? new Date(m.issued) : new Date();
      const ends   = m.window_end ? new Date(m.window_end) : new Date();
      els.metricIssuedTime.textContent = _formatTimeUtcAndEt(issued);
      els.metricIssuedDate.textContent =
        issued.toUTCString().slice(5, 16);
      els.metricWindow.textContent    = (m.window_hours || state.window) + ' hr';
      els.metricWindowSub.textContent =
        'through ' + ends.toUTCString().slice(17, 22) + ' UTC';
    }

    els.metricThreshold.innerHTML =
      '\u2265 ' + (CFG.formatThresholdInches(state.threshold) || '--');
    els.metricThresholdSub.textContent = 'NDFD category ' + state.threshold;

    els.metricFlagged.textContent = String(summary.flagged);
    els.metricFlaggedSub.textContent =
      'of ' + summary.total + ' debris flow pathways';

    if (summary.flagged > 0) {
      els.metricFlaggedCard.classList.add('has-alerts');
    } else {
      els.metricFlaggedCard.classList.remove('has-alerts');
    }
  }

  function _updateSourceMeta(activeFC) {
    const m = (activeFC && activeFC.meta) || {};

    // Source: render as a clickable link to the upstream data service
    // if we have a URL for the current mode. Built via DOM API rather
    // than innerHTML so text from data.meta is safely escaped.
    while (els.metaSource.firstChild) {
      els.metaSource.removeChild(els.metaSource.firstChild);
    }
    const sourceText = m.source || '--';
    const sourceUrl  = (CFG.SOURCE_LINKS && CFG.SOURCE_LINKS[state.mode]) || null;

    if (sourceUrl && sourceText !== '--') {
      const link = document.createElement('a');
      link.href   = sourceUrl;
      link.target = '_blank';
      link.rel    = 'noopener noreferrer';
      link.textContent = sourceText;
      // Trailing external-link icon (north-east arrow). aria-hidden so
      // screen readers don't announce it; the link's target="_blank" is
      // already implied by convention.
      const icon = document.createElement('span');
      icon.className = 'external-link-icon';
      icon.setAttribute('aria-hidden', 'true');
      icon.textContent = '\u2197';   // northeast arrow
      link.appendChild(document.createTextNode(' '));
      link.appendChild(icon);
      els.metaSource.appendChild(link);
    } else {
      els.metaSource.textContent = sourceText;
    }

    if (state.mode === 'historical') {
      els.metaTimeLabel.textContent = 'Event window';
      els.metaTime.textContent = m.date_label || m.end_date || '--';

      els.metaExtraLabel.hidden = false;
      els.metaExtra.hidden = false;
      els.metaExtraLabel.textContent = 'Max observed';
      els.metaExtra.textContent = (m.max_inches != null)
        ? m.max_inches.toFixed(2) + '\u2033'
        : '--';
    } else if (state.mode === 'mrms') {
      els.metaTimeLabel.textContent = 'Observed';
      const obs = m.observed_at ? new Date(m.observed_at) : null;
      els.metaTime.textContent = obs
        ? obs.toUTCString().slice(5, 22) + ' UTC'
        : '--';

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
  // re-fetch the live data files. The frontend cache-busts via
  // `cache: 'no-cache'` in _fetchInto so we always see the latest cron
  // output.
  //
  // This is NOT just _loadLiveData() because _loadLiveData is cache-aware
  // (a no-op if the requested window is already loaded). Auto-refresh
  // needs to bypass that cache and pull whatever files are on disk now,
  // for whatever windows are currently in use for each mode.
  function _autoRefreshTick() {
    const promises = [];
    const ndfdWin = state.loadedWindows.ndfd;
    const mrmsWin = state.loadedWindows.mrms;

    if (ndfdWin != null) {
      promises.push(_fetchInto(`data/forecast_${ndfdWin}h.geojson`,     'NDFD_FORECAST'));
      promises.push(_fetchInto(`data/flagged_ndfd_${ndfdWin}h.geojson`, 'FLAGGED_NDFD'));
    }
    if (mrmsWin != null) {
      promises.push(_fetchInto(`data/observed_${mrmsWin}h.geojson`,     'MRMS_OBSERVED'));
      promises.push(_fetchInto(`data/flagged_mrms_${mrmsWin}h.geojson`, 'FLAGGED_MRMS'));
    }

    if (promises.length === 0) {
      // Nothing tracked yet (initial preload may not have completed).
      // Fall back to the cache-aware loader, which will fetch if needed.
      _loadLiveData().then(refresh);
      return;
    }

    _setLoading(true);
    Promise.allSettled(promises).then(function () {
      _setLoading(false);
      refresh();
    });
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
