/* =========================================================================
 * table.js - flagged pathways table + CSV export for DFENS Simple
 *
 * The table is the accessible, canonical list of what is flagged; the map
 * is a visual aid. Rows sort by forecast rain (highest first), then
 * county, then pathway ID.
 *
 * Public surface (window.DFS_TABLE):
 *   render(features, tbody, summaryEl, onSelect)
 *   toCSV(features, ctx) -> string
 * ========================================================================= */

window.DFS_TABLE = (function () {
  'use strict';

  const CFG = window.DFS_CONFIG;

  function sortFeatures(features) {
    return features.slice().sort(function (a, b) {
      const pa = a.properties, pb = b.properties;
      if (pb.max_category !== pa.max_category) return pb.max_category - pa.max_category;
      const c = String(pa.county || '').localeCompare(String(pb.county || ''));
      if (c !== 0) return c;
      return (pa.OBJECTID || 0) - (pb.OBJECTID || 0);
    });
  }

  function _acres(p) {
    const a = Number(p.area_acres);
    if (!isFinite(a)) return '--';
    return a < 1 ? a.toFixed(2) : a.toFixed(1);
  }

  function render(features, tbody, summaryEl, onSelect) {
    while (tbody.firstChild) tbody.removeChild(tbody.firstChild);

    if (!features.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 5;
      td.className = 'empty-row is-none';
      td.textContent = 'No debris flow pathways in WNC are forecast to receive ' +
        '5 inches or more of rain in this 24-hour period.';
      tr.appendChild(td);
      tbody.appendChild(tr);
      summaryEl.textContent = 'None flagged.';
      summaryEl.classList.add('is-none');
      return;
    }

    const counties = new Set();
    for (const f of features) {
      const p = f.properties;
      if (p.county) counties.add(p.county);

      const tr = document.createElement('tr');
      tr.tabIndex = 0;
      tr.className = 'row-clickable';
      tr.dataset.objectid = String(p.OBJECTID);
      tr.setAttribute('aria-label',
        'Show pathway ' + p.OBJECTID + ' in ' + (p.county || 'unknown county') + ' on the map');

      const cells = [
        p.county || '--',
        p.watershed || '--',
        CFG.PRECIP_LABELS[p.max_category] || '--',
        _acres(p),
        String(p.OBJECTID)
      ];
      cells.forEach(function (text, i) {
        const td = document.createElement('td');
        td.textContent = text;
        if (i >= 3) td.className = 'num';
        tr.appendChild(td);
      });

      tr.addEventListener('click', function () { onSelect(p.OBJECTID); });
      tr.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(p.OBJECTID);
        }
      });
      tbody.appendChild(tr);
    }

    const n = features.length;
    summaryEl.classList.remove('is-none');
    summaryEl.textContent = n + ' pathway' + (n === 1 ? '' : 's') + ' in ' +
      counties.size + ' count' + (counties.size === 1 ? 'y' : 'ies') + '.';
  }

  function toCSV(features, ctx) {
    const header = ['county', 'watershed', 'forecast_rain', 'ndfd_category',
                    'area_acres', 'pathway_id', 'window_start_utc',
                    'window_end_utc', 'nws_updated_utc', 'exported_utc'];
    const exported = new Date().toISOString();
    const rows = [header.join(',')];
    for (const f of features) {
      const p = f.properties;
      rows.push([
        p.county || '', p.watershed || '',
        CFG.PRECIP_LABELS[p.max_category] || '', p.max_category,
        _acres(p), p.OBJECTID,
        ctx.windowStart || '', ctx.windowEnd || '', ctx.issued || '', exported
      ].map(_csvEscape).join(','));
    }
    return rows.join('\r\n') + '\r\n';
  }

  function _csvEscape(v) {
    if (v == null) return '';
    const s = String(v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  return { render, toCSV, sortFeatures };
})();
