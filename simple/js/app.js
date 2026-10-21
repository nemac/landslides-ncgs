/* =========================================================================
 * app.js - DFENS Simple controller
 *
 * One fixed view: NDFD 24-hour forecast rain total, >= 5 inches.
 * No mode, window or threshold controls.
 *
 * Time labelling is deliberately literal. The NDFD layer accumulates rain
 * from the start of the current forecast cycle (00/06/12/18 UTC), which is
 * up to ~6 hours BEFORE the data was fetched. So the window shown is the
 * actual start and end the pipeline used (meta.window_start / window_end),
 * not "the next 24 hours", and the page says when part of it is past.
 * ========================================================================= */

(function () {
  'use strict';

  const CFG   = window.DFS_CONFIG;
  const MAP   = window.DFS_MAP;
  const TABLE = window.DFS_TABLE;
  const $ = (id) => document.getElementById(id);

  const els = {
    loading:      $('loading-indicator'),
    statusCard:   $('status-card'),
    statusCount:  $('status-count'),
    statusLabel:  $('status-count-label'),
    statusWindow: $('status-window'),
    windowNote:   $('status-window-note'),
    statusIssued: $('status-issued'),
    statusChecked:$('status-checked'),
    statusNext:   $('status-next'),
    staleBanner:  $('stale-banner'),
    tbody:        $('alerts-tbody'),
    tableSummary: $('table-summary'),
    exportBtn:    $('export-csv'),
    sourceLink:   $('source-link'),
    layerNdfd:      $('layer-ndfd'),
    layerRadar:     $('layer-radar'),
    layerMrms:      $('layer-mrms'),
    layerAlerts:    $('layer-alerts'),
    layerReference: $('layer-reference'),
    layerParcels:   $('layer-parcels'),
    layerBuildings: $('layer-buildings')
  };

  const state = { features: [], meta: {}, status: null, timer: null, nextTimer: null };

  // ---- Time formatting -----------------------------------------------------
  const ET_DAY_TIME = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'short', month: 'short',
    day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true
  });
  const ET_TIME = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: true
  });
  const ET_DATE = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric'
  });
  const UTC_SHORT = new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false
  });

  // "Wed, Oct 7, 8:00 AM ET"
  function fmtEt(d) { return ET_DAY_TIME.format(d) + ' ET'; }
  // "Oct 7, 12:00 UTC"
  function fmtUtc(d) { return UTC_SHORT.format(d) + ' UTC'; }
  // "1:12 PM ET" if today (ET), else "Tue, Oct 6, 1:12 PM ET"
  function fmtEtRelative(d) {
    const sameDay = ET_DATE.format(d) === ET_DATE.format(new Date());
    return sameDay ? ET_TIME.format(d) + ' ET' : fmtEt(d);
  }
  function hoursBetween(a, b) { return (b - a) / 3600000; }
  function fmtAge(mins) {
    if (mins < 90) return Math.round(mins) + ' minutes';
    const h = mins / 60;
    return (h < 48 ? h.toFixed(0) + ' hours' : (h / 24).toFixed(0) + ' days');
  }

  // ---- Init ----------------------------------------------------------------
  function init() {
    MAP.init();
    _buildLegend();
    _buildMrmsRamp();
    _wireZoomGating();
    _fillRefreshTable();
    els.sourceLink.href = CFG.NDFD_SOURCE_URL;
    _wireLayerToggles();
    els.exportBtn.addEventListener('click', _exportCsv);
    loadData();
    state.timer = setInterval(loadData, CFG.AUTO_REFRESH_MS);
    // Keep "next check in N min" and the window hours current between loads.
    setInterval(function () {
      if (state.meta && state.meta.window_start) {
        _renderWindow(state.meta);
        _renderIssued(state.meta, state.status);
      }
    }, 30000);
    // Re-check staleness/"already past" wording when the tab comes back.
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) loadData();
    });
  }

  // Compact NDFD legend in the layer panel (collapsed by default).
  function _buildLegend() {
    const ul = document.getElementById('ndfd-legend-list');
    if (!ul) return;
    for (let cat = 0; cat <= 19; cat++) {
      const li = document.createElement('li');
      if (cat >= CFG.THRESHOLD_CATEGORY) li.className = 'at-threshold';
      const sw = document.createElement('span');
      sw.className = 'legend-swatch';
      sw.setAttribute('aria-hidden', 'true');
      sw.style.background = CFG.PRECIP_COLORS[cat];
      li.appendChild(sw);
      li.appendChild(document.createTextNode(CFG.PRECIP_LABELS[cat]));
      ul.appendChild(li);
    }
  }

  // The NDFD window steps at 00/06/12/18 UTC; show those in local ET so
  // the table stays right across daylight-saving changes.
  function _fillRefreshTable() {
    const el = document.getElementById('window-step-times');
    if (!el) return;
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', hour: 'numeric', hour12: true
    });
    const now = new Date();
    const times = [0, 6, 12, 18].map(function (h) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h));
      return { label: fmt.format(d), sortKey: Number(new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' }).format(d)) };
    }).sort(function (a, b) { return a.sortKey - b.sortKey; });
    el.textContent = times.map(function (t) { return t.label; }).join(', ') + ' ET';
  }

  // Grey out Parcels / Buildings until the map is zoomed in far enough
  // for them to draw.
  function _wireZoomGating() {
    const map = MAP._internalMap && MAP._internalMap();
    if (!map) return;
    const rows = [
      [document.getElementById('row-parcels'),   CFG.NCONEMAP_PARCELS_MIN_ZOOM],
      [document.getElementById('row-buildings'), CFG.BUILDINGS_MIN_ZOOM]
    ];
    function update() {
      const z = map.getZoom();
      rows.forEach(function (r) {
        if (r[0]) r[0].classList.toggle('below-zoom', z < r[1]);
      });
    }
    map.on('zoomend', update);
    update();
  }

  // MRMS legend: a CSS gradient bar with tick marks, drawn from the
  // stops sampled off IEM's official legend image (crisp at any size).
  function _buildMrmsRamp() {
    const bar = document.getElementById('mrms-ramp-bar');
    const ticks = document.getElementById('mrms-ramp-ticks');
    if (!bar || !ticks) return;
    bar.style.background = 'linear-gradient(to right, ' +
      CFG.MRMS_24H_RAMP.map(function (s) { return s[1] + ' ' + s[0] + '%'; }).join(', ') + ')';
    CFG.MRMS_24H_TICKS.forEach(function (t) {
      const el = document.createElement('span');
      el.className = 'ramp-tick';
      el.style.left = t[0] + '%';
      el.textContent = t[1];
      ticks.appendChild(el);
    });
  }

  function _wireLayerToggles() {
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
      const on = this.checked;
      if (on) _setLoading(true);
      Promise.resolve(MAP.setReferenceVisible(on)).then(function () {
        if (on) _setLoading(false);
      });
    });
    els.layerParcels.addEventListener('change', function () {
      MAP.setParcelsVisible(this.checked);
    });
    els.layerBuildings.addEventListener('change', function () {
      MAP.setBuildingsVisible(this.checked);
    });
  }

  // ---- Data ----------------------------------------------------------------
  // status.json is rewritten by every pipeline check (every ~10 min), so
  // its checked_at tells us the pipeline is alive even when NDFD hasn't
  // changed. The flagged file only changes when NDFD does.
  async function _fetchJson(name) {
    const r = await fetch(CFG.dataBase() + name, { cache: 'no-cache' });
    if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + name);
    return r.json();
  }

  async function loadData() {
    _setLoading(true);
    try {
      const [fc, status, forecast] = await Promise.all([
        _fetchJson(CFG.FLAGGED_FILE),
        _fetchJson(CFG.STATUS_FILE).catch(function (e) {
          console.warn('[DFS] status unavailable: ' + e.message);
          return null;
        }),
        _fetchJson(CFG.FORECAST_FILE).catch(function (e) {
          console.warn('[DFS] forecast layer unavailable: ' + e.message);
          return null;
        })
      ]);
      // Map layer: full NDFD coverage straight from the service, for the
      // same 24-h period as the flagged pathways.
      MAP.setForecastPeriod(fc && fc.meta);
      MAP.refreshObserved();
      if (!fc || fc.type !== 'FeatureCollection') throw new Error('flagged file is not GeoJSON');
      const feats = (fc.features || []).filter(function (f) {
        return Number(f.properties.max_category) >= CFG.THRESHOLD_CATEGORY;
      });
      state.features = TABLE.sortFeatures(feats);
      state.meta = fc.meta || {};
      state.status = status;
      _render();
      _scheduleAfterNextCheck();
    } catch (e) {
      console.error('[DFS] Could not load forecast data:', e);
      _showError();
    } finally {
      _setLoading(false);
    }
  }

  // ---- Render --------------------------------------------------------------
  function _render() {
    const m = state.meta;
    const n = state.features.length;

    els.statusCount.textContent = String(n);
    els.statusCard.classList.toggle('has-alerts', n > 0);
    els.statusCard.classList.toggle('is-zero', n === 0);

    _renderWindow(m);
    _renderIssued(m, state.status);
    _renderStale(m, state.status);

    MAP.setAlerts({ type: 'FeatureCollection', features: state.features });
    MAP.setAlertsVisible(els.layerAlerts.checked);

    TABLE.render(state.features, els.tbody, els.tableSummary, MAP.zoomToAlert);
    els.exportBtn.disabled = n === 0;
  }

  function _renderWindow(m) {
    const now = new Date();
    if (!m.window_start || !m.window_end) {
      // Files from before the pipeline recorded real window bounds.
      els.statusWindow.textContent = 'About the next 24 hours';
      els.windowNote.textContent = 'Exact start and end times are not in this data file.';
      return;
    }
    const start = new Date(m.window_start);
    const end   = new Date(m.window_end);
    els.statusWindow.textContent = fmtEt(start) + ' – ' + fmtEt(end);

    const notes = [fmtUtc(start) + ' – ' + fmtUtc(end)];
    if (end <= now) {
      notes.push('This period has ended.');
    }
    els.windowNote.textContent = notes.join('. ');
  }

  function _intervalMin(status) {
    const v = status && Number(status.check_interval_minutes);
    return v > 0 ? v : CFG.CHECK_INTERVAL_MINUTES;
  }

  function _renderIssued(m, status) {
    const iv = document.getElementById('check-interval-text');
    if (iv) iv.textContent = String(_intervalMin(status));
    els.statusIssued.textContent = m.issued ? fmtEtRelative(new Date(m.issued)) : 'Unknown';
    // "Checked" = when the pipeline last asked NDFD for news (heartbeat);
    // falls back to when this data file was built.
    const checked = (status && status.checked_at) || m.generated_at;
    els.statusChecked.textContent = checked
      ? 'Last checked for updates ' + fmtEtRelative(new Date(checked))
      : '';
    // Next scheduled check = last check + interval.
    if (checked) {
      const next = new Date(new Date(checked).getTime() + _intervalMin(status) * 60000);
      const mins = Math.ceil((next - new Date()) / 60000);
      els.statusNext.textContent = mins >= 1
        ? 'Next update check in ' + mins + ' min'
        : 'Checking for updates now\u2026';
      els.statusNext.classList.toggle('is-checking', mins < 1);
    } else {
      els.statusNext.classList.remove('is-checking');
      els.statusNext.textContent = 'Checks for updates every ' + _intervalMin(status) + ' min';
    }
  }

  // Re-load shortly after the next scheduled check so new data shows up
  // promptly (the 5-minute timer is the fallback).
  function _scheduleAfterNextCheck() {
    clearTimeout(state.nextTimer);
    const checked = state.status && state.status.checked_at;
    if (!checked) return;
    const due = new Date(checked).getTime() + _intervalMin(state.status) * 60000 + 60000;
    const wait = due - Date.now();
    if (wait > 0 && wait < CFG.AUTO_REFRESH_MS) {
      state.nextTimer = setTimeout(loadData, wait);
    }
  }

  function _renderStale(m, status) {
    const now = new Date();
    const msgs = [];
    const checked = (status && status.checked_at) || m.generated_at;
    if (checked) {
      const ageMin = (now - new Date(checked)) / 60000;
      if (ageMin > CFG.STALE_AFTER_MINUTES) {
        msgs.push('This page has not been able to check for a new forecast in ' +
          fmtAge(ageMin) + '. The forecast may have changed. Check current NWS ' +
          'forecasts at weather.gov.');
      }
    } else {
      msgs.push('The age of this data is unknown. Check current NWS forecasts at weather.gov.');
    }
    if (m.window_end && new Date(m.window_end) <= now) {
      msgs.push('The forecast period shown has already ended.');
    }
    els.staleBanner.hidden = msgs.length === 0;
    els.staleBanner.textContent = msgs.join(' ');
  }

  function _showError() {
    els.statusCount.textContent = '--';
    els.statusWindow.textContent = 'Unavailable';
    els.windowNote.textContent = '';
    els.statusNext.textContent = '';
    els.staleBanner.hidden = false;
    els.staleBanner.textContent =
      'Forecast data could not be loaded. Try again in a few minutes, and ' +
      'check current NWS forecasts at weather.gov.';
    els.tableSummary.textContent = 'Data unavailable.';
    els.tableSummary.classList.remove('is-none');
    els.statusCard.classList.remove('is-zero');
    els.tbody.innerHTML =
      '<tr><td colspan="5" class="empty-row">Forecast data could not be loaded.</td></tr>';
    els.exportBtn.disabled = true;
  }

  // ---- CSV -----------------------------------------------------------------
  function _exportCsv() {
    if (!state.features.length) return;
    const m = state.meta;
    const csv = TABLE.toCSV(state.features, {
      windowStart: m.window_start, windowEnd: m.window_end, issued: m.issued
    });
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'dfens-flagged-24h-5in-' + ts + 'Z.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  // ---- Loading indicator (reference-counted) -------------------------------
  let _loadingCount = 0;
  function _setLoading(on) {
    _loadingCount = Math.max(0, _loadingCount + (on ? 1 : -1));
    const busy = _loadingCount > 0;
    els.loading.hidden = !busy;
    els.loading.setAttribute('aria-busy', busy ? 'true' : 'false');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
