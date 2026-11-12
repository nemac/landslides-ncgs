/* =========================================================================
 * table.js - flagged pathways table + CSV export for DFENS Simple
 *
 * The table is the accessible, canonical list of what is flagged; the map
 * is a visual aid. Pathways are grouped by their primary NC fire district
 * (the district containing the pathway), so a dispatcher can work through
 * the list one department at a time:
 *
 *   ▾ Asheville Fire Department · FDID 01101 · Buncombe · 14 pathways · max 6–8″
 *       pathway rows (rain highest first, then county, then ID)
 *   ▾ ...
 *   ▾ Outside NC fire districts            (TN / GA / SC / VA pathways)
 *
 * Districts sort by highest forecast rain, then number of pathways, then
 * name. Groups can be collapsed; collapsed state survives auto-refresh.
 *
 * Public surface (window.DFS_TABLE):
 *   render(features, tbody, summaryEl, handlers)
 *       handlers.onSelect(objectid)        row click -> zoom to one pathway
 *       handlers.onZoomGroup([objectid])   "Show on map" -> zoom to a group
 *   toCSV(features, ctx) -> string
 *   sortFeatures(features) -> features
 *   groupFeatures(features) -> [{key, label, fdid, county, address, features, maxCat}]
 * ========================================================================= */

window.DFS_TABLE = (function () {
  'use strict';

  const CFG = window.DFS_CONFIG;
  const NONE_KEY = '__none__';
  const NONE_LABEL = 'Outside NC fire districts';
  const collapsed = new Set(); // group keys the user has collapsed

  function sortFeatures(features) {
    return features.slice().sort(function (a, b) {
      const pa = a.properties,
        pb = b.properties;
      if (pb.max_category !== pa.max_category)
        return pb.max_category - pa.max_category;
      const c = String(pa.county || '').localeCompare(String(pb.county || ''));
      if (c !== 0) return c;
      return (pa.OBJECTID || 0) - (pb.OBJECTID || 0);
    });
  }

  function _groupKey(p) {
    if (p.fdid) return 'fdid:' + p.fdid;
    if (p.fire_department) return 'name:' + p.fire_department;
    return NONE_KEY;
  }

  function groupFeatures(features) {
    const byKey = new Map();
    sortFeatures(features).forEach(function (f) {
      const p = f.properties;
      const key = _groupKey(p);
      if (!byKey.has(key)) {
        byKey.set(key, {
          key: key,
          label:
            key === NONE_KEY
              ? NONE_LABEL
              : p.fire_department || 'FDID ' + p.fdid,
          fdid: p.fdid || null,
          county: p.fd_county || null,
          address: p.fd_address || null,
          features: [],
          maxCat: -1,
        });
      }
      const g = byKey.get(key);
      g.features.push(f);
      if (p.max_category > g.maxCat) g.maxCat = p.max_category;
    });
    return Array.from(byKey.values()).sort(function (a, b) {
      if ((a.key === NONE_KEY) !== (b.key === NONE_KEY))
        return a.key === NONE_KEY ? 1 : -1;
      if (b.maxCat !== a.maxCat) return b.maxCat - a.maxCat;
      if (b.features.length !== a.features.length)
        return b.features.length - a.features.length;
      return a.label.localeCompare(b.label);
    });
  }

  function _acres(p) {
    const a = Number(p.area_acres);
    if (!isFinite(a)) return '--';
    return a < 1 ? a.toFixed(2) : a.toFixed(1);
  }

  function _plural(n, one, many) {
    return n.toLocaleString('en-US') + ' ' + (n === 1 ? one : many);
  }

  function _groupMeta(g) {
    const bits = [];
    if (g.fdid) bits.push('FDID ' + g.fdid);
    if (g.county) bits.push(g.county + ' County');
    bits.push(_plural(g.features.length, 'pathway', 'pathways'));
    bits.push('max ' + (CFG.PRECIP_LABELS[g.maxCat] || '--'));
    return bits.join(' · ');
  }

  function render(features, tbody, summaryEl, handlers) {
    handlers = handlers || {};
    while (tbody.firstChild) tbody.removeChild(tbody.firstChild);

    if (!features.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 5;
      td.className = 'empty-row is-none';
      td.textContent =
        'No debris flow pathways in WNC are forecast to receive ' +
        '5 inches or more of rain in this 24-hour period.';
      tr.appendChild(td);
      tbody.appendChild(tr);
      summaryEl.textContent = 'None flagged';
      summaryEl.classList.add('is-none');
      return;
    }

    const groups = groupFeatures(features);
    groups.forEach(function (g, gi) {
      const rowsId = 'fd-group-' + gi;
      const isCollapsed = collapsed.has(g.key);

      // ---- District header row --------------------------------------
      const hr = document.createElement('tr');
      hr.className = 'group-row' + (g.key === NONE_KEY ? ' is-outside' : '');
      const th = document.createElement('th');
      th.colSpan = 5;
      th.scope = 'colgroup';

      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'group-toggle';
      toggle.setAttribute('aria-expanded', String(!isCollapsed));
      const name = document.createElement('span');
      name.className = 'group-name';
      name.textContent = g.label;
      const meta = document.createElement('span');
      meta.className = 'group-meta';
      meta.textContent = _groupMeta(g);
      toggle.appendChild(name);
      toggle.appendChild(meta);
      toggle.setAttribute(
        'aria-label',
        g.label +
          ', ' +
          _groupMeta(g) +
          '. ' +
          (isCollapsed ? 'Expand' : 'Collapse') +
          ' list'
      );

      const zoom = document.createElement('button');
      zoom.type = 'button';
      zoom.className = 'group-zoom';
      zoom.textContent = 'Show on map';
      zoom.setAttribute(
        'aria-label',
        'Show ' + g.label + ' pathways on the map'
      );
      zoom.addEventListener('click', function () {
        if (handlers.onZoomGroup) {
          handlers.onZoomGroup(
            g.features.map(function (f) {
              return f.properties.OBJECTID;
            })
          );
        }
      });

      const head = document.createElement('div');
      head.className = 'group-head';
      head.appendChild(toggle);
      head.appendChild(zoom);
      th.appendChild(head);
      hr.appendChild(th);
      tbody.appendChild(hr);

      // ---- Pathway rows ------------------------------------------------
      const rows = [];
      g.features.forEach(function (f) {
        const p = f.properties;
        const tr = document.createElement('tr');
        tr.tabIndex = 0;
        tr.className = 'row-clickable group-item';
        tr.dataset.objectid = String(p.OBJECTID);
        tr.dataset.group = rowsId;
        tr.hidden = isCollapsed;
        tr.setAttribute(
          'aria-label',
          'Show pathway ' +
            p.OBJECTID +
            ' in ' +
            (p.county || 'unknown county') +
            ' on the map'
        );

        [
          p.county || '--',
          p.watershed || '--',
          CFG.PRECIP_LABELS[p.max_category] || '--',
          _acres(p),
          String(p.OBJECTID),
        ].forEach(function (text, i) {
          const td = document.createElement('td');
          td.textContent = text;
          if (i >= 3) td.className = 'num';
          tr.appendChild(td);
        });

        tr.addEventListener('click', function () {
          if (handlers.onSelect) handlers.onSelect(p.OBJECTID);
        });
        tr.addEventListener('keydown', function (e) {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            if (handlers.onSelect) handlers.onSelect(p.OBJECTID);
          }
        });
        rows.push(tr);
        tbody.appendChild(tr);
      });

      toggle.addEventListener('click', function () {
        const nowCollapsed = toggle.getAttribute('aria-expanded') === 'true';
        toggle.setAttribute('aria-expanded', String(!nowCollapsed));
        toggle.setAttribute(
          'aria-label',
          g.label +
            ', ' +
            _groupMeta(g) +
            '. ' +
            (nowCollapsed ? 'Expand' : 'Collapse') +
            ' list'
        );
        rows.forEach(function (r) {
          r.hidden = nowCollapsed;
        });
        if (nowCollapsed) collapsed.add(g.key);
        else collapsed.delete(g.key);
      });
    });

    // ---- Summary ---------------------------------------------------------
    const n = features.length;
    const districts = groups.filter(function (g) {
      return g.key !== NONE_KEY;
    }).length;
    const outside = groups
      .filter(function (g) {
        return g.key === NONE_KEY;
      })
      .reduce(function (s, g) {
        return s + g.features.length;
      }, 0);
    let text =
      _plural(n, 'pathway', 'pathways') +
      ' in ' +
      _plural(districts, 'fire district', 'fire districts');
    if (outside)
      text += ' (' + outside.toLocaleString('en-US') + ' outside NC districts)';
    summaryEl.classList.remove('is-none');
    summaryEl.textContent = text;
  }

  function toCSV(features, ctx) {
    const header = [
      'fdid',
      'fire_department',
      'fd_county',
      'fd_address',
      'district_updated',
      'county',
      'watershed',
      'forecast_rain',
      'ndfd_category',
      'area_acres',
      'pathway_id',
      'window_start_utc',
      'window_end_utc',
      'nws_updated_utc',
      'exported_utc',
      'forecast_source',
    ];
    const exported = new Date().toISOString();
    const rows = [header.join(',')];
    groupFeatures(features).forEach(function (g) {
      g.features.forEach(function (f) {
        const p = f.properties;
        rows.push(
          [
            p.fdid || '',
            p.fire_department || '',
            p.fd_county || '',
            p.fd_address || '',
            p.district_updated || '',
            p.county || '',
            p.watershed || '',
            CFG.PRECIP_LABELS[p.max_category] || '',
            p.max_category,
            _acres(p),
            p.OBJECTID,
            ctx.windowStart || '',
            ctx.windowEnd || '',
            ctx.issued || '',
            exported,
            ctx.simulated
              ? 'SIMULATED (test data, not an NWS forecast)'
              : 'NWS NDFD',
          ]
            .map(_csvEscape)
            .join(',')
        );
      });
    });
    return rows.join('\r\n') + '\r\n';
  }

  function _csvEscape(v) {
    if (v == null) return '';
    const s = String(v);
    // Leading zeros in FDID survive because the value is written as text;
    // Excel may still strip them on open - import as text if that matters.
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  return { render, toCSV, sortFeatures, groupFeatures };
})();
