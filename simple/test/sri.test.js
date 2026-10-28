// Checks every third-party script and stylesheet the dashboards load from a
// CDN. Subresource integrity can only break a page one way: the browser
// refuses a file whose hash does not match, and the page silently loses that
// library. So the test fetches each CDN file and recomputes its hash, and
// also insists that every CDN tag carries a hash in the first place.
//
// Needs network access (it downloads the files from unpkg). Run with:
//   node --test "simple/test/*.test.js"
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PAGES = ['simple/index.html', 'alerts/index.html'];

// Tags that cannot carry an integrity hash: preconnect hints load no file,
// and Google Fonts serves a different stylesheet to each browser.
function isExemptFromIntegrity(tag) {
  return /rel="preconnect"/.test(tag) || /fonts\.googleapis\.com/.test(tag);
}

function attribute(tag, name) {
  const match = tag.match(new RegExp(name + '="([^"]*)"'));
  return match ? match[1] : null;
}

// Every <script> or <link> tag whose src/href is an absolute https URL.
function cdnTagsIn(html) {
  const tags = html.match(/<(?:script|link)\b[^>]*>/g) || [];
  return tags.filter((tag) => /\b(?:src|href)="https:\/\//.test(tag));
}

function hashOf(bytes, algorithm) {
  return crypto.createHash(algorithm).update(bytes).digest('base64');
}

async function download(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
  assert.equal(response.status, 200, 'GET ' + url);
  return Buffer.from(await response.arrayBuffer());
}

for (const page of PAGES) {
  const html = fs.readFileSync(path.join(REPO_ROOT, page), 'utf8');
  const tags = cdnTagsIn(html).filter((tag) => !isExemptFromIntegrity(tag));

  test(page + ' loads at least one hashed CDN file', () => {
    assert.ok(tags.length > 0, 'no CDN tags found in ' + page);
  });

  for (const tag of tags) {
    const url = attribute(tag, 'src') || attribute(tag, 'href');
    const integrity = attribute(tag, 'integrity');

    test(page + ': ' + url + ' has an integrity hash and crossorigin', () => {
      assert.ok(integrity, 'missing integrity attribute on ' + url);
      assert.ok(
        /\bcrossorigin\b/.test(tag),
        'missing crossorigin attribute on ' + url
      );
    });

    test(page + ': ' + url + ' matches its integrity hash', async () => {
      const [algorithm, expected] = integrity.split('-', 2);
      assert.match(
        algorithm,
        /^sha(256|384|512)$/,
        'unsupported algorithm on ' + url
      );
      const actual = hashOf(await download(url), algorithm);
      assert.equal(
        actual,
        expected,
        'hash mismatch for ' +
          url +
          ': the file served does not match the integrity attribute'
      );
    });
  }
}
