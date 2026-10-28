// Builds the DFENS Simple page in jsdom and runs config.js, table.js and
// app.js inside it, with the map module and fetch replaced by recorders.
// app.js initialises itself as soon as it runs, so a test gets a page that
// has already started its first load; `settle()` waits for that load.
//
// Time: the caller enables node:test's mock timers first (see FIXED_NOW).
// The page's Date and timer functions are pointed at Node's, so the mocked
// clock and timers are the ones app.js sees.
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');
const { readScript } = require('./load-script');

const SIMPLE_DIR = path.resolve(__dirname, '..');
const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const HTML = fs.readFileSync(path.join(SIMPLE_DIR, 'index.html'), 'utf8');

// 2:40 PM ET on 2026-10-27, two minutes after the live fixture's checked_at.
const FIXED_NOW = Date.parse('2026-10-27T18:40:00Z');

const FILES = {
  flagged: 'flagged_ndfd_24h_min11.geojson',
  status: 'status.json',
  forecast: 'forecast_24h.geojson',
};

// The three data files of one fixture folder, parsed. Tests change the
// copy they get (it is theirs) before handing it to loadPage.
function fixture(folder) {
  const out = {};
  for (const [key, file] of Object.entries(FILES)) {
    const text = fs.readFileSync(path.join(FIXTURES_DIR, folder, file), 'utf8');
    out[key] = JSON.parse(text);
  }
  return out;
}

function okResponse(body) {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(JSON.parse(JSON.stringify(body))),
  };
}

function errorResponse(status) {
  return {
    ok: false,
    status,
    json: () => Promise.reject(new Error('no body')),
  };
}

// A response the test resolves by hand, for ordering two loads.
function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// fetch replacement. `data` maps the file keys above to a body, a
// response object, a Promise of one, or a function returning any of those
// (called per request, so a test can answer differently each time).
function fakeFetch(data, calls) {
  return function (url) {
    calls.push(url);
    const key = Object.keys(FILES).find((k) => url.endsWith(FILES[k]));
    let answer = data[key];
    if (typeof answer === 'function') answer = answer(url);
    if (answer === undefined) return Promise.resolve(errorResponse(404));
    return Promise.resolve(answer).then((a) =>
      a && typeof a.ok === 'boolean' ? a : okResponse(a)
    );
  };
}

// Stands in for window.DFS_MAP: records every call, and gives app.js a
// map with a zoom level and a zoomend event for the zoom gating.
function fakeMapModule() {
  const calls = [];
  const handlers = {};
  const map = {
    zoom: 8,
    getZoom() {
      return this.zoom;
    },
    on(event, fn) {
      (handlers[event] = handlers[event] || []).push(fn);
    },
    fire(event) {
      (handlers[event] || []).forEach((fn) => fn());
    },
  };
  const stub = { calls, map, reference: null };
  for (const name of [
    'init',
    'setForecastPeriod',
    'setForecastVisible',
    'setRadarVisible',
    'setObservedVisible',
    'refreshObserved',
    'setAlerts',
    'setAlertsVisible',
    'zoomToAlert',
    'setParcelsVisible',
    'setBuildingsVisible',
  ]) {
    stub[name] = (...args) => {
      calls.push([name, ...args]);
    };
  }
  stub.setReferenceVisible = (on) => {
    calls.push(['setReferenceVisible', on]);
    stub.reference = deferred();
    return stub.reference.promise;
  };
  stub._internalMap = () => map;
  return stub;
}

function loadPage(options) {
  const opts = options || {};
  const data = opts.data || fixture('live');
  const fetchCalls = [];
  const consoleLines = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('error', (...a) => consoleLines.push(['error', ...a]));
  virtualConsole.on('warn', (...a) => consoleLines.push(['warn', ...a]));
  virtualConsole.on('log', () => {});

  const dom = new JSDOM(HTML, {
    runScripts: 'outside-only',
    url: 'http://localhost:8000/simple/' + (opts.search || ''),
    pretendToBeVisual: true,
    virtualConsole,
  });
  const win = dom.window;

  // Node's (possibly mocked) clock and timers, not jsdom's.
  win.Date = globalThis.Date;
  win.setTimeout = globalThis.setTimeout;
  win.clearTimeout = globalThis.clearTimeout;
  win.setInterval = globalThis.setInterval;
  win.clearInterval = globalThis.clearInterval;

  win.fetch = fakeFetch(data, fetchCalls);
  const MAP = fakeMapModule();
  win.DFS_MAP = MAP;

  // Downloads: record the blob URL and file name instead of navigating.
  const downloads = [];
  const blobs = [];
  win.URL.createObjectURL = (blob) => {
    blobs.push(blob);
    return 'blob:fake/' + blobs.length;
  };
  win.URL.revokeObjectURL = () => {};
  win.HTMLAnchorElement.prototype.click = function () {
    downloads.push({ href: this.href, download: this.download });
  };

  for (const name of ['config.js', 'table.js', 'app.js']) {
    win.eval(readScript(name));
  }

  const $ = (id) => win.document.getElementById(id);

  // Let every pending fetch and the render after it finish.
  async function settle() {
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setImmediate(r));
    }
  }

  function mapCalls(name) {
    return MAP.calls.filter((c) => c[0] === name);
  }

  return {
    window: win,
    document: win.document,
    $,
    MAP,
    fetchCalls,
    consoleLines,
    downloads,
    blobs,
    settle,
    mapCalls,
    close: () => win.close(),
  };
}

module.exports = {
  loadPage,
  fixture,
  okResponse,
  errorResponse,
  deferred,
  FIXED_NOW,
};
