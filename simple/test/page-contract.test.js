// The HTML and the scripts agree: every element id the scripts look up is
// in simple/index.html, every local asset the page references is in the
// tree, and the scripts load in dependency order. Catches a rename in one
// file that the other never heard about.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { readScript } = require('./load-script');

const SIMPLE_DIR = path.resolve(__dirname, '..');
const HTML = fs.readFileSync(path.join(SIMPLE_DIR, 'index.html'), 'utf8');
const CSS = fs.readFileSync(path.join(SIMPLE_DIR, 'css', 'styles.css'), 'utf8');

function idsInHtml() {
  return new Set(Array.from(HTML.matchAll(/\bid="([^"]+)"/g), (m) => m[1]));
}

function idsLookedUpBy(script) {
  const source = readScript(script);
  const ids = new Set();
  for (const m of source.matchAll(/(?:\$|getElementById)\('([^']+)'\)/g)) {
    ids.add(m[1]);
  }
  return ids;
}

// Ids the scripts look up but guard with a null check on purpose: the
// element may be absent from the page.
const OPTIONAL_IDS = new Set(['buildings-zoom-hint']);

for (const script of ['app.js', 'map.js']) {
  test(script + ' only looks up element ids that index.html defines', () => {
    const present = idsInHtml();
    const missing = Array.from(idsLookedUpBy(script)).filter(
      (id) => !present.has(id) && !OPTIONAL_IDS.has(id)
    );
    assert.deepEqual(missing, []);
  });
}

test('no element id appears twice in index.html', () => {
  const all = Array.from(HTML.matchAll(/\bid="([^"]+)"/g), (m) => m[1]);
  const seen = new Set();
  const dupes = all.filter((id) => seen.has(id) || !seen.add(id));
  assert.deepEqual(dupes, []);
});

test('every local src, href and url() resolves against the tree', () => {
  const refs = [];
  for (const m of HTML.matchAll(/\b(?:src|href)="([^"]+)"/g)) refs.push(m[1]);
  for (const m of CSS.matchAll(/url\(["']?([^"')]+)["']?\)/g)) {
    refs.push(path.posix.join('css', m[1]));
  }
  const local = refs.filter(
    (r) => !/^(https?:|\/\/|#|mailto:|tel:|data:)/.test(r)
  );
  const missing = local.filter(
    (r) => !fs.existsSync(path.join(SIMPLE_DIR, r.split(/[?#]/)[0]))
  );
  assert.ok(local.length >= 4, 'expected the stylesheet and three scripts');
  assert.deepEqual(missing, []);
});

test('the scripts load config, map, table, app, in that order', () => {
  const order = Array.from(
    HTML.matchAll(/<script src="js\/([a-z]+)\.js"/g),
    (m) => m[1]
  );
  assert.deepEqual(order, ['config', 'map', 'table', 'app']);
});

test('the page states the fixed threshold the config enforces', () => {
  const { loadScripts } = require('./load-script');
  const cfg = loadScripts(['config.js'], {
    location: { search: '' },
  }).DFS_CONFIG;
  assert.equal(cfg.THRESHOLD_INCHES, 5);
  assert.match(HTML, /5&Prime; precipitation in 24 hours/);
  assert.match(HTML, /at least 5 inches of rain/);
});
