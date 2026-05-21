/* =========================================================================
 * alerts.js — compute alerts and render them in an accessible table
 *
 * Public surface (exported on window.DEFNS_ALERTS):
 *   compute(precipFeatures, debrisFeatures, threshold)
 *     -> { alerts: GeoJSON FeatureCollection, summary: {flagged, total, ...} }
 *
 *   render(alertsFC, tbodyEl, summaryEl)
 *     -> populates an accessible <tbody> + updates the live-region summary
 *
 * Uses turf.js (loaded globally as `turf`) for the geometric intersection.
 * ========================================================================= */

window.DEFNS_ALERTS = (function () {
  'use strict';

  const CFG = window.DEFNS_CONFIG;

  /**
   * compute(precip, debris, threshold)
   *
   * For each debris flow feature: find the maximum NDFD category among
   * precip polygons it intersects. If that max is >= threshold, the debris
   * polygon is flagged.
   *
   * @param {FeatureCollection} precip   - NDFD or MRMS polygons (category in props)
   * @param {FeatureCollection} debris   - debris flow polygons (OBJECTID in props)
   * @param {number} threshold           - NDFD category threshold (0-19)
   *
   * @returns {{ alerts: FeatureCollection, summary: object }}
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

    // Pre-filter precip to those at or above the threshold. Saves work
    // for the inner loop.
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
        // turf.booleanIntersects is fast and avoids constructing the actual
        // intersection geometry (we only need to know "do they touch").
        let intersects = false;
        try {
          intersects = turf.booleanIntersects(dfFeat, pFeat);
        } catch (e) {
          // Skip malformed geometries rather than blowing up the whole loop
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
   * render(alertsFC, tbody, summaryEl)
   *
   * Replaces the rows in tbody with an accessible row per alert.
   * Updates the live-region summary text. Both elements come from the DOM.
   */
  function render(alertsFC, tbody, summaryEl) {
    // Clear existing rows
    while (tbody.firstChild) tbody.removeChild(tbody.firstChild);

    const features = alertsFC.features || [];

    if (!features.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 5;
      td.className = 'empty-row';
      td.textContent =
        'No debris flow zones meet the current threshold. ' +
        'Try lowering the threshold or changing detection mode.';
      tr.appendChild(td);
      tbody.appendChild(tr);
      if (summaryEl) {
        summaryEl.textContent = 'No zones flagged at the current threshold.';
      }
      return;
    }

    // Sort by precip category descending (worst first) - most useful default
    features.sort(function (a, b) {
      const ac = a.properties.precip_category;
      const bc = b.properties.precip_category;
      if (bc !== ac) return bc - ac;
      // Tiebreak by OBJECTID for stability
      return (a.properties.OBJECTID || 0) - (b.properties.OBJECTID || 0);
    });

    for (const f of features) {
      const p = f.properties;
      const tr = document.createElement('tr');

      const cellId      = document.createElement('td');
      const cellCounty  = document.createElement('td');
      const cellCat     = document.createElement('td');
      const cellRain    = document.createElement('td');
      const cellArea    = document.createElement('td');

      cellId.textContent     = p.OBJECTID;
      cellCounty.textContent = p.county || '--';

      // Category with color swatch (decorative; the text label carries
      // meaning for screen readers).
      const swatch = document.createElement('span');
      swatch.className = 'legend-swatch';
      swatch.setAttribute('aria-hidden', 'true');
      swatch.style.background =
        CFG.PRECIP_COLORS[p.precip_category] || '#888';
      swatch.style.marginRight = '6px';
      cellCat.appendChild(swatch);
      cellCat.appendChild(document.createTextNode('cat ' + p.precip_category));

      cellRain.textContent = p.precip_label || '--';
      cellArea.textContent = _estimateAcres(f.geometry);

      tr.appendChild(cellId);
      tr.appendChild(cellCounty);
      tr.appendChild(cellCat);
      tr.appendChild(cellRain);
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

  // ---- Helpers ------------------------------------------------------------

  /**
   * Quick acres estimate from a polygon geometry. Uses turf.area (m^2)
   * and converts. Reasonable for small WNC polygons; not survey-grade.
   */
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

  return { compute, render };
})();
