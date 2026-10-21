// Loads one CloudFront Function source piece and returns its single
// top-level function by name. The pieces are plain scripts (no modules), so
// evaluating the source followed by `return <name>` is the whole trick.
const fs = require('node:fs');
const path = require('node:path');

function loadPiece(file, name) {
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  return new Function(source + '\n; return ' + name + ';')();
}

// A viewer-request event in the shape CloudFront Functions receive.
function eventFor(host, uri, extra) {
  const headers = host ? { host: { value: host } } : {};
  const request = Object.assign({ uri, querystring: {}, headers }, extra || {});
  return { request };
}

module.exports = { loadPiece, eventFor };
