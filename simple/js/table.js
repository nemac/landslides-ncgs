/* =========================================================================
 * table.js - flagged pathways table + CSV export for DFENS Simple
 *
 * The table is the accessible, canonical list of what is flagged; the map
 * is a visual aid. It has two modes, and it never guesses a district:
 *
 * Districts known: the flagged file says the fire district lookup ran
 * (meta.fire_districts is "ok") and every pathway has a status. Pathways
 * are grouped, one <tbody> per group:
 *
 *   ▾ Asheville Fire Department · FDID 11101 · Buncombe County · 2 pathways · max 5–6″
 *       pathway rows (rain highest first, then county, then ID)
 *   ▾ ... (more real districts: highest rain, then most pathways, then name)
 *   ▾ No District               (land the state's data marks "No District")
 *   ▾ Outside North Carolina    (no district polygon matched)
 *
 * Districts not known (the lookup failed, or an older file without the
 * fields): one plain list sorted by rain, county and ID, plus a notice.
 *
 * Groups can be collapsed; collapsed groups stay collapsed when the page
 * reloads its data.
 *
 * Public surface (window.DFS_TABLE):
 *   render(features, meta, elements, handlers)
 *       elements: { table, summary, notice, focusFallback }
 *           focusFallback takes focus when the focused row or group
 *           button is gone after a redraw (the table's heading)
 *       handlers.onSelect(pathwayId)       row click -> zoom to one pathway
 *       handlers.onZoomGroup([pathwayId])  "Show on map" -> zoom to a group
 *   renderMessage(text, elements)          one message row (the error state)
 *   toCSV(features, meta) -> string
 *   districtsKnown(features, meta) -> bool
 *   sortFeatures(features) -> features
 *   groupFeatures(features) -> [{key, kind, name, note, fdid, county, features, maxCat}]
 * ========================================================================= */

window.DFS_TABLE = (function () {
  'use strict';

  const CFG = window.DFS_CONFIG;

  const STATUS_DISTRICT = 'district';
  const STATUS_NO_DISTRICT = 'no_district';
  const STATUS_OUTSIDE_NC = 'outside_nc';
  const KNOWN_STATUSES = [
    STATUS_DISTRICT,
    STATUS_NO_DISTRICT,
    STATUS_OUTSIDE_NC,
  ];

  const NO_DISTRICT_KEY = 'special:no_district';
  const OUTSIDE_NC_KEY = 'special:outside_nc';

  const NOTICE_TEXT =
    'Fire district information is unavailable right now. ' +
    'Pathways are listed without districts.';
  const EMPTY_TEXT =
    'No debris flow pathways in WNC are forecast to receive ' +
    '5 inches or more of rain in this 24-hour period.';
  const CAPTION_START =
    'Debris flow pathways forecast to receive 5 inches or more of rain ' +
    'in 24 hours, ';
  const CAPTION_PLAIN =
    CAPTION_START +
    'highest rain first. Select a row to show that pathway on the map.';
  const CAPTION_GROUPED =
    CAPTION_START +
    'grouped by NC fire district, highest rain first. Select a district ' +
    'heading to collapse or expand it, or a row to show that pathway on ' +
    'the map.';

  const COLUMN_COUNT = 5;
  const collapsedGroupKeys = new Set();

  // ---- Sorting and grouping ------------------------------------------------
  function sortFeatures(features) {
    return features.slice().sort(function (a, b) {
      const pa = a.properties;
      const pb = b.properties;
      if (pb.max_category !== pa.max_category) {
        return pb.max_category - pa.max_category;
      }
      const byCounty = String(pa.county || '').localeCompare(
        String(pb.county || '')
      );
      if (byCounty !== 0) return byCounty;
      return (pa.pathway_id || 0) - (pb.pathway_id || 0);
    });
  }

  // Only trust the districts when the lookup ran and every pathway has an
  // answer. One missing answer means we cannot say which group it is in.
  function districtsKnown(features, meta) {
    if (!meta || meta.fire_districts !== 'ok') return false;
    return features.every(function (f) {
      return KNOWN_STATUSES.includes(f.properties.fire_district_status);
    });
  }

  function _districtKey(p) {
    if (p.fdid) return 'fdid:' + p.fdid;
    return 'name:' + (p.fire_department || '');
  }

  function _districtName(p) {
    return p.fire_department || 'Unnamed fire district';
  }

  function _newGroup(kind, key, name) {
    return {
      key: key,
      kind: kind,
      name: name,
      note: null,
      fdid: null,
      county: null,
      features: [],
      maxCat: -1,
    };
  }

  function _newDistrictGroup(p) {
    const group = _newGroup(STATUS_DISTRICT, _districtKey(p), _districtName(p));
    group.fdid = p.fdid || null;
    group.county = p.fd_county || null;
    return group;
  }

  function _newNoDistrictGroup() {
    const group = _newGroup(STATUS_NO_DISTRICT, NO_DISTRICT_KEY, 'No District');
    group.note = "listed as No District in the state's fire district data";
    return group;
  }

  function _addToGroup(group, feature) {
    group.features.push(feature);
    const category = feature.properties.max_category;
    if (category > group.maxCat) group.maxCat = category;
  }

  function _compareDistricts(a, b) {
    if (b.maxCat !== a.maxCat) return b.maxCat - a.maxCat;
    if (b.features.length !== a.features.length) {
      return b.features.length - a.features.length;
    }
    return a.name.localeCompare(b.name);
  }

  // Real districts first, then "No District", then "Outside North
  // Carolina". Call this only when districtsKnown() is true.
  function groupFeatures(features) {
    const districts = new Map();
    const noDistrict = _newNoDistrictGroup();
    const outsideNc = _newGroup(
      STATUS_OUTSIDE_NC,
      OUTSIDE_NC_KEY,
      'Outside North Carolina'
    );

    sortFeatures(features).forEach(function (feature) {
      const p = feature.properties;
      if (p.fire_district_status === STATUS_NO_DISTRICT) {
        _addToGroup(noDistrict, feature);
        return;
      }
      if (p.fire_district_status === STATUS_OUTSIDE_NC) {
        _addToGroup(outsideNc, feature);
        return;
      }
      const key = _districtKey(p);
      if (!districts.has(key)) districts.set(key, _newDistrictGroup(p));
      _addToGroup(districts.get(key), feature);
    });

    const groups = Array.from(districts.values()).sort(_compareDistricts);
    if (noDistrict.features.length) groups.push(noDistrict);
    if (outsideNc.features.length) groups.push(outsideNc);
    return groups;
  }

  // ---- Small text helpers --------------------------------------------------
  function _acres(p) {
    const a = Number(p.area_acres);
    if (!isFinite(a)) return '--';
    return a < 1 ? a.toFixed(2) : a.toFixed(1);
  }

  function _plural(n, one, many) {
    return n.toLocaleString('en-US') + ' ' + (n === 1 ? one : many);
  }

  function _rainLabel(category) {
    return CFG.PRECIP_LABELS[category] || '--';
  }

  function _groupMetaText(group) {
    const bits = [];
    if (group.note) bits.push(group.note);
    if (group.fdid) bits.push('FDID ' + group.fdid);
    if (group.county) bits.push(group.county + ' County');
    bits.push(_plural(group.features.length, 'pathway', 'pathways'));
    bits.push('max ' + _rainLabel(group.maxCat));
    return bits.join(' · ');
  }

  function _countInKind(groups, kind) {
    let count = 0;
    groups.forEach(function (group) {
      if (group.kind === kind) count += group.features.length;
    });
    return count;
  }

  function _groupedSummary(features, groups) {
    const districtCount = groups.filter(function (group) {
      return group.kind === STATUS_DISTRICT;
    }).length;
    const noDistrictCount = _countInKind(groups, STATUS_NO_DISTRICT);
    const outsideCount = _countInKind(groups, STATUS_OUTSIDE_NC);

    let text = _plural(features.length, 'pathway', 'pathways');
    if (districtCount > 0) {
      text +=
        ' in ' + _plural(districtCount, 'fire district', 'fire districts');
    }
    const extras = [];
    if (noDistrictCount > 0) {
      extras.push(
        noDistrictCount.toLocaleString('en-US') + ' with no district'
      );
    }
    if (outsideCount > 0) {
      extras.push(
        outsideCount.toLocaleString('en-US') + ' outside North Carolina'
      );
    }
    if (extras.length) text += ' (' + extras.join(', ') + ')';
    return text;
  }

  function _plainSummary(features) {
    const counties = new Set();
    features.forEach(function (f) {
      if (f.properties.county) counties.add(f.properties.county);
    });
    return (
      _plural(features.length, 'pathway', 'pathways') +
      ' in ' +
      _plural(counties.size, 'county', 'counties')
    );
  }

  // ---- Page pieces around the table ---------------------------------------
  function _setSummary(summaryEl, text, isNone) {
    summaryEl.textContent = text;
    summaryEl.classList.toggle('is-none', isNone);
  }

  function _setCaption(table, text) {
    if (table.caption) table.caption.textContent = text;
  }

  // The notice region stays in the page so screen readers hear the text
  // when it is added. Writing the same text again would repeat the
  // announcement on every reload, so only a change touches it.
  function _setNotice(region, text) {
    if (!region || region.textContent === text) return;
    while (region.firstChild) region.removeChild(region.firstChild);
    if (!text) return;
    const message = document.createElement('p');
    message.className = 'district-notice';
    message.textContent = text;
    region.appendChild(message);
  }

  function _clearBodies(table) {
    Array.from(table.tBodies).forEach(function (body) {
      table.removeChild(body);
    });
  }

  function _messageBody(text, extraClass) {
    const body = document.createElement('tbody');
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = COLUMN_COUNT;
    cell.className = 'empty-row' + (extraClass ? ' ' + extraClass : '');
    cell.textContent = text;
    row.appendChild(cell);
    body.appendChild(row);
    return body;
  }

  // ---- Pathway rows --------------------------------------------------------
  function _pathwayCells(p) {
    return [
      p.county || '--',
      p.watershed || '--',
      _rainLabel(p.max_category),
      _acres(p),
      String(p.pathway_id),
    ];
  }

  function _buildPathwayRow(feature, onSelect) {
    const p = feature.properties;
    const row = document.createElement('tr');
    row.tabIndex = 0;
    row.className = 'row-clickable';
    row.dataset.pathwayId = String(p.pathway_id);
    row.setAttribute(
      'aria-label',
      'Show pathway ' +
        p.pathway_id +
        ' in ' +
        (p.county || 'unknown county') +
        ' on the map'
    );
    _pathwayCells(p).forEach(function (text, index) {
      const cell = document.createElement('td');
      cell.textContent = text;
      if (index >= 3) cell.className = 'num';
      row.appendChild(cell);
    });

    function select() {
      if (onSelect) onSelect(p.pathway_id);
    }
    row.addEventListener('click', select);
    row.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        select();
      }
    });
    return row;
  }

  // ---- Group headings ------------------------------------------------------
  function _buildToggleButton(group, pathwayRows) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'group-toggle';
    button.setAttribute(
      'aria-expanded',
      String(!collapsedGroupKeys.has(group.key))
    );

    const name = document.createElement('span');
    name.className = 'group-name';
    name.textContent = group.name;
    // Keeps the name and the details apart when a screen reader reads the
    // button as one phrase.
    const separator = document.createElement('span');
    separator.className = 'sr-only';
    separator.textContent = ', ';
    const meta = document.createElement('span');
    meta.className = 'group-meta';
    meta.textContent = _groupMetaText(group);
    button.appendChild(name);
    button.appendChild(separator);
    button.appendChild(meta);

    button.addEventListener('click', function () {
      const collapse = button.getAttribute('aria-expanded') === 'true';
      button.setAttribute('aria-expanded', String(!collapse));
      pathwayRows.forEach(function (row) {
        row.hidden = collapse;
      });
      if (collapse) collapsedGroupKeys.add(group.key);
      else collapsedGroupKeys.delete(group.key);
    });
    return button;
  }

  function _buildZoomButton(group, onZoomGroup) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'group-zoom';
    button.textContent = 'Show on map';
    // Starts with the visible words, so speech users can say what they see.
    button.setAttribute('aria-label', 'Show on map: ' + group.name);

    button.addEventListener('click', function () {
      if (!onZoomGroup) return;
      onZoomGroup(
        group.features.map(function (f) {
          return f.properties.pathway_id;
        })
      );
    });
    return button;
  }

  function _buildGroupHeaderRow(group, pathwayRows, handlers) {
    const row = document.createElement('tr');
    row.className = 'group-row';
    if (group.kind !== STATUS_DISTRICT) row.classList.add('is-special');
    const cell = document.createElement('th');
    cell.scope = 'rowgroup';
    cell.colSpan = COLUMN_COUNT;

    const head = document.createElement('div');
    head.className = 'group-head';
    head.appendChild(_buildToggleButton(group, pathwayRows));
    head.appendChild(_buildZoomButton(group, handlers.onZoomGroup));
    cell.appendChild(head);
    row.appendChild(cell);
    return row;
  }

  function _buildGroupBody(group, handlers) {
    const body = document.createElement('tbody');
    body.className = 'group';
    // Lets a redraw find this group again (see _findPart).
    body.dataset.groupKey = group.key;
    const isCollapsed = collapsedGroupKeys.has(group.key);
    const pathwayRows = group.features.map(function (feature) {
      const row = _buildPathwayRow(feature, handlers.onSelect);
      row.classList.add('group-item');
      row.hidden = isCollapsed;
      return row;
    });
    body.appendChild(_buildGroupHeaderRow(group, pathwayRows, handlers));
    pathwayRows.forEach(function (row) {
      body.appendChild(row);
    });
    return body;
  }

  // ---- Keeping keyboard focus across a redraw -------------------------------
  // A redraw deletes every row, and the focused row or button with it. The
  // browser then drops focus to the top of the page. So render() notes
  // which part had focus first, and focuses its replacement afterwards.
  function _focusedPart(table) {
    const focused = document.activeElement;
    if (!focused || !table.contains(focused)) return null;
    if (focused.dataset.pathwayId) {
      return { pathwayId: focused.dataset.pathwayId };
    }
    const body = focused.closest('tbody');
    if (focused.tagName === 'BUTTON' && body && body.dataset.groupKey) {
      return { groupKey: body.dataset.groupKey, className: focused.className };
    }
    return null;
  }

  function _findRow(table, pathwayId) {
    const rows = Array.from(table.querySelectorAll('tr[data-pathway-id]'));
    return rows.find(function (row) {
      return row.dataset.pathwayId === pathwayId;
    });
  }

  function _findGroupButton(table, groupKey, className) {
    const body = Array.from(table.tBodies).find(function (candidate) {
      return candidate.dataset.groupKey === groupKey;
    });
    return body ? body.querySelector('button.' + className) : null;
  }

  function _findPart(table, part) {
    if (part.pathwayId) return _findRow(table, part.pathwayId);
    return _findGroupButton(table, part.groupKey, part.className);
  }

  // `part` is what _focusedPart() returned before the redraw. When that
  // pathway or group is gone, or is now inside a collapsed group, focus
  // goes to elements.focusFallback (the table's heading) instead.
  function _restoreFocus(elements, part) {
    if (!part) return;
    const target = _findPart(elements.table, part);
    if (target && !target.hidden) {
      target.focus();
    } else if (elements.focusFallback) {
      elements.focusFallback.focus();
    }
  }

  // ---- Render --------------------------------------------------------------
  function _renderEmpty(elements) {
    elements.table.appendChild(_messageBody(EMPTY_TEXT, 'is-none'));
    _setSummary(elements.summary, 'None flagged', true);
    _setNotice(elements.notice, '');
    _setCaption(elements.table, CAPTION_PLAIN);
  }

  function _renderPlain(features, elements, handlers) {
    const body = document.createElement('tbody');
    sortFeatures(features).forEach(function (feature) {
      body.appendChild(_buildPathwayRow(feature, handlers.onSelect));
    });
    elements.table.appendChild(body);
    _setSummary(elements.summary, _plainSummary(features), false);
    _setNotice(elements.notice, NOTICE_TEXT);
    _setCaption(elements.table, CAPTION_PLAIN);
  }

  function _renderGrouped(features, elements, handlers) {
    const groups = groupFeatures(features);
    groups.forEach(function (group) {
      elements.table.appendChild(_buildGroupBody(group, handlers));
    });
    _setSummary(elements.summary, _groupedSummary(features, groups), false);
    _setNotice(elements.notice, '');
    _setCaption(elements.table, CAPTION_GROUPED);
  }

  function render(features, meta, elements, handlers) {
    const focusedPart = _focusedPart(elements.table);
    _clearBodies(elements.table);
    if (!features.length) {
      _renderEmpty(elements);
    } else if (districtsKnown(features, meta)) {
      _renderGrouped(features, elements, handlers || {});
    } else {
      _renderPlain(features, elements, handlers || {});
    }
    _restoreFocus(elements, focusedPart);
  }

  // Replaces every body in the table, grouped or not, with one message row.
  // The caller sets the summary text.
  function renderMessage(text, elements) {
    const focusedPart = _focusedPart(elements.table);
    _clearBodies(elements.table);
    elements.table.appendChild(_messageBody(text, null));
    _restoreFocus(elements, focusedPart);
    _setNotice(elements.notice, '');
    _setCaption(elements.table, CAPTION_PLAIN);
  }

  // ---- CSV -----------------------------------------------------------------
  // The pathway's own columns come first. The district status sits right
  // before the five columns it explains. Then come the times, and last the
  // NCGS layer version that the pathway IDs belong to.
  const CSV_HEADER = [
    'pathway_id',
    'county',
    'watershed',
    'forecast_rain',
    'ndfd_category',
    'area_acres',
    'fire_district_status',
    'fire_department',
    'fdid',
    'fd_county',
    'fd_address',
    'district_updated',
    'window_start_utc',
    'window_end_utc',
    'nws_updated_utc',
    'exported_utc',
    'ncgs_layer_version',
  ];

  function _csvPathwayCells(p) {
    return [
      p.pathway_id,
      p.county || '',
      p.watershed || '',
      CFG.PRECIP_LABELS[p.max_category] || '',
      p.max_category,
      _acres(p),
    ];
  }

  // The status and the five district columns. The five stay blank unless
  // districts are known, so the file never names a district the table
  // would not show.
  function _csvDistrictCells(p, known) {
    if (!known) return ['unavailable', '', '', '', '', ''];
    return [
      p.fire_district_status,
      p.fire_department || '',
      p.fdid || '',
      p.fd_county || '',
      p.fd_address || '',
      p.district_updated || '',
    ];
  }

  function _csvTimeCells(meta, exported) {
    return [
      meta.window_start || '',
      meta.window_end || '',
      meta.issued || '',
      exported,
    ];
  }

  function _csvRow(p, meta, exported, known) {
    return _csvPathwayCells(p)
      .concat(
        _csvDistrictCells(p, known),
        _csvTimeCells(meta, exported),
        // A pathway_id is a row number in one version of the NCGS layer,
        // so the file says which version. Blank for an older file.
        [meta.ncgs_layer_version || '']
      )
      .map(_csvEscape)
      .join(',');
  }

  function _featuresInTableOrder(features, known) {
    if (!known) return sortFeatures(features);
    const ordered = [];
    groupFeatures(features).forEach(function (group) {
      group.features.forEach(function (f) {
        ordered.push(f);
      });
    });
    return ordered;
  }

  function toCSV(features, meta) {
    const safeMeta = meta || {};
    const known = districtsKnown(features, safeMeta);
    const exported = new Date().toISOString();
    const rows = [CSV_HEADER.join(',')];
    _featuresInTableOrder(features, known).forEach(function (f) {
      rows.push(_csvRow(f.properties, safeMeta, exported, known));
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

  return {
    render,
    renderMessage,
    toCSV,
    districtsKnown,
    sortFeatures,
    groupFeatures,
  };
})();
