/* =========================================================================
 * alerts.js — compute alerts and render them in an accessible table
 *
 * Public surface (exported on window.DEFNS_ALERTS):
 *   compute(precipFeatures, debrisFeatures, threshold)
 *     -> { alerts: GeoJSON FeatureCollection, summary: {flagged, total, ...} }
 *
 *   render(alertsFC, tbodyEl, summaryEl, ctx)
 *     -> populates an accessible <tbody> + updates the live-region summary
 *        ctx is { source, timestamp } - used for the Source column.
 *
 *   toCSV(alertsFC, ctx)
 *     -> returns a CSV string with header row + one row per alert
 *
 * Uses turf.js (loaded globally as `turf`) for the geometric intersection.
 * ========================================================================= */

window.DEFNS_ALERTS = (function () {
  'use strict';

  const CFG = window.DEFNS_CONFIG;

  /**
   * compute(precip, debris, threshold)
   * (unchanged from previous version)
   */
  function compute(precip, debris, threshold) {
    if (!precip || !precip.features || !precip.features.length ||
        !debris || !debris.features || !debris.features.length) {
      return {
        alerts: { type: 'FeatureCollection', features: [] },
        summary: { flagged: 0, total: (debris && debris.features) ? debris.features.length : 0,
                   maxCategory: null }
      };
    }

    const qualifyingPrecip = {
      type: 'FeatureCollection',
      features: precip.features.filter(
        f => Number(f.properties.category) >= threshold
      )
    };

    if (!qualifyingPrecip.features.length) {
      return {
        alerts: { type: 'FeatureCollection', features: [] },
        summary: { flagged: 0, total: debris.features.length, maxCategory: null }
      };
    }

    const flagged = [];
    let maxCategorySeen = -1;

    for (const dfFeat of debris.features) {
      let bestCat = -1;
      let bestLabel = null;

      for (const pFeat of qualifyingPrecip.features) {
        let intersects = false;
        try {
          intersects = turf.booleanIntersects(dfFeat, pFeat);
        } catch (e) {
          console.warn('[DEFNS] turf.booleanIntersects failed:', e);
          continue;
        }
        if (intersects) {
          const cat = Number(pFeat.properties.category);
          if (cat > bestCat) {
            bestCat = cat;
            bestLabel = pFeat.properties.label;
          }
        }
      }

      if (bestCat >= threshold) {
        if (bestCat > maxCategorySeen) maxCategorySeen = bestCat;
        flagged.push({
          type: 'Feature',
          properties: {
            ...dfFeat.properties,
            precip_category: bestCat,
            precip_label:    bestLabel
          },
          geometry: dfFeat.geometry
        });
      }
    }

    return {
      alerts: { type: 'FeatureCollection', features: flagged },
      summary: {
        flagged:     flagged.length,
        total:       debris.features.length,
        maxCategory: maxCategorySeen >= 0 ? maxCategorySeen : null
      }
    };
  }

  /**
   * render(alertsFC, tbody, summaryEl, ctx)
   *
   * @param {FeatureCollection} alertsFC
   * @param {HTMLElement} tbody
   * @param {HTMLElement} summaryEl
   * @param {Object} ctx
   *    .sourceLabel    short source identifier shown in table cell ("NDFD" / "MRMS")
   *    .timestamp      string for the time cell ("18:00 UTC May 25" etc)
   */
  function render(alertsFC, tbody, summaryEl, ctx) {
    ctx = ctx || {};
    while (tbody.firstChild) tbody.removeChild(tbody.firstChild);

    const features = alertsFC.features || [];

    if (!features.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 8;
      td.className = 'empty-row';
      td.textContent =
        'No debris flow zones meet the current threshold. ' +
        'Try lowering the threshold or changing detection mode.';
      tr.appendChild(td);
      tbody.appendChild(tr);
      if (summaryEl) {
        summaryEl.textContent = 'No pathways flagged at the current threshold.';
      }
      return;
    }

    features.sort(function (a, b) {
      const ac = a.properties.precip_category;
      const bc = b.properties.precip_category;
      if (bc !== ac) return bc - ac;
      return (a.properties.OBJECTID || 0) - (b.properties.OBJECTID || 0);
    });

    // Precip threshold display - same for every row (it's the current
    // slider position). Computed once outside the loop.
    const thresholdLabel = ctx.thresholdLabel || '--';

    for (const f of features) {
      const p = f.properties;
      const tr = document.createElement('tr');
      tr.dataset.objectid = String(p.OBJECTID || '');

      // Polygon ID
      const cellId = document.createElement('td');
      cellId.textContent = p.OBJECTID;

      // County
      const cellCounty = document.createElement('td');
      cellCounty.textContent = p.county || '--';

      // Watershed (HUC12 name)
      const cellWatershed = document.createElement('td');
      cellWatershed.textContent = p.watershed || '--';

      // Category with color swatch
      const cellCat = document.createElement('td');
      const swatch = document.createElement('span');
      swatch.className = 'legend-swatch';
      swatch.setAttribute('aria-hidden', 'true');
      swatch.style.background = CFG.PRECIP_COLORS[p.precip_category] || '#888';
      swatch.style.marginRight = '6px';
      cellCat.appendChild(swatch);
      cellCat.appendChild(document.createTextNode('cat ' + p.precip_category));

      // Precip threshold - same value all rows; e.g. ">= 5.00\u2033".
      // Encodes what the user's current slider position requires.
      const cellThreshold = document.createElement('td');
      cellThreshold.textContent = thresholdLabel;

      // Source + timestamp
      const cellSource = document.createElement('td');
      const sourceStrong = document.createElement('strong');
      sourceStrong.textContent = ctx.sourceLabel || '--';
      cellSource.appendChild(sourceStrong);
      if (ctx.timestamp) {
        const timeSpan = document.createElement('span');
        timeSpan.className = 'cell-sub';
        timeSpan.textContent = ' \u00b7 ' + ctx.timestamp;
        cellSource.appendChild(timeSpan);
      }

      // Forecast window - per-source duration label.
      // E.g. "12 hr forecast" / "1 hr observed" / "7-day accumulation".
      const cellWindow = document.createElement('td');
      cellWindow.textContent = ctx.windowLabel || '--';

      // Area
      const cellArea = document.createElement('td');
      cellArea.textContent = _estimateAcres(f.geometry);

      tr.appendChild(cellId);
      tr.appendChild(cellCounty);
      tr.appendChild(cellWatershed);
      tr.appendChild(cellCat);
      tr.appendChild(cellThreshold);
      tr.appendChild(cellSource);
      tr.appendChild(cellWindow);
      tr.appendChild(cellArea);

      tbody.appendChild(tr);
    }

    if (summaryEl) {
      const maxCat = features[0].properties.precip_category;
      summaryEl.textContent =
        `${features.length} zone${features.length === 1 ? '' : 's'} ` +
        `flagged. Highest precipitation category: ${maxCat} ` +
        `(${features[0].properties.precip_label || '--'}).`;
    }
  }

  /**
   * toCSV(alertsFC, ctx) -> CSV string for download
   * Header columns match the on-screen table plus area-in-meters for utility.
   */
  function toCSV(alertsFC, ctx) {
    ctx = ctx || {};
    const features = (alertsFC && alertsFC.features) || [];

    const header = [
      'polygon_id',
      'county',
      'watershed',
      'precip_category',
      'precip_label',
      'precip_threshold',
      'source',
      'forecast_window',
      'data_timestamp_utc',
      'export_timestamp_utc',
      'area_acres'
    ];

    const exportTs = new Date().toISOString();
    const rows = [header.join(',')];

    for (const f of features) {
      const p = f.properties || {};
      const fields = [
        p.OBJECTID || '',
        p.county || '',
        p.watershed || '',
        p.precip_category != null ? p.precip_category : '',
        p.precip_label || '',
        ctx.thresholdLabel || '',
        ctx.sourceLabel || '',
        ctx.windowLabel || '',
        ctx.timestampISO || '',
        exportTs,
        _estimateAcres(f.geometry)
      ];
      rows.push(fields.map(_csvEscape).join(','));
    }

    return rows.join('\r\n') + '\r\n';
  }

  // ---- Helpers ------------------------------------------------------------

  function _estimateAcres(geometry) {
    if (!geometry) return '--';
    try {
      const sqMeters = turf.area({ type: 'Feature', geometry: geometry,
                                   properties: {} });
      const acres = sqMeters / 4046.86;
      return acres < 1 ? acres.toFixed(2) : acres.toFixed(1);
    } catch (e) {
      return '--';
    }
  }

  function _csvEscape(val) {
    if (val == null) return '';
    const s = String(val);
    // RFC 4180: quote any field containing comma, quote, or newline
    if (/[",\r\n]/.test(s)) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  return { compute, render, toCSV };
})();
