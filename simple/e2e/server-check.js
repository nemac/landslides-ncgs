// Keeps the browser tests on this checkout's files.
//
// On 2026-11-13 `npm run test:e2e` passed while it was testing another
// checkout. A server from that checkout was already on the port, and the
// tests reused it. Three rules stop that:
//   1. The tests have their own port, not the preview's port 8000.
//      SIMPLE_E2E_PORT picks another one, so two checkouts can test at once.
//   2. Playwright never reuses a running server (playwright.config.js).
//   3. Before any test runs, the server must hand back a random token that
//      was just written into this checkout (global-setup.js).
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_PORT = 8765;
const TOKEN_FILE_PREFIX = '.e2e-server-token-'; // git-ignored

// The port the test server listens on. `env` is process.env.
function e2ePort(env) {
  const text = env.SIMPLE_E2E_PORT;
  if (text === undefined || text === '') return DEFAULT_PORT;
  const port = Number(text);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      'SIMPLE_E2E_PORT must be a port number from 1 to 65535, not "' +
        text +
        '".'
    );
  }
  return port;
}

async function _fetchText(url) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) return null;
  return response.text();
}

// Throws unless the server at `origin` serves the files in `folder`. It
// writes a fresh random token into the folder and asks the server for it:
// only a server that reads this folder can answer with the same token.
async function requireServerReadsFolder(origin, folder) {
  const token = crypto.randomUUID();
  // Each run has its own file name, so two runs in one checkout at the
  // same time do not delete each other's token.
  const tokenFileName = TOKEN_FILE_PREFIX + crypto.randomUUID();
  const tokenPath = path.join(folder, tokenFileName);
  fs.writeFileSync(tokenPath, token);
  try {
    const served = await _fetchText(origin + '/' + tokenFileName);
    if (served !== token) {
      throw new Error(
        'The server at ' +
          origin +
          ' is not serving this checkout (' +
          folder +
          '). Another server is probably using the port. Stop it, or set ' +
          'SIMPLE_E2E_PORT to a free port.'
      );
    }
  } finally {
    fs.rmSync(tokenPath, { force: true });
  }
}

module.exports = {
  DEFAULT_PORT,
  TOKEN_FILE_PREFIX,
  e2ePort,
  requireServerReadsFolder,
};
