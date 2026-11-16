// Checks the rules that keep the browser tests on this checkout's files.
// On 2026-11-13 `npm run test:e2e` passed while it was testing another
// checkout: a server from that checkout was already on the port, and the
// tests reused it. So the tests now have their own port, never reuse a
// server, and prove that the server reads this folder.
//
// Run with: node --test "simple/test/*.test.js"
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const serverCheck = require('../e2e/server-check.js');

const CONFIG_PATH = require.resolve('../e2e/playwright.config.js');
const PREVIEW_PORT = 8000; // the `static-site` launch config

// The config reads the port when it loads, so each test loads it fresh.
function loadConfig(env) {
  const saved = process.env.SIMPLE_E2E_PORT;
  delete process.env.SIMPLE_E2E_PORT;
  if (env.SIMPLE_E2E_PORT) process.env.SIMPLE_E2E_PORT = env.SIMPLE_E2E_PORT;
  delete require.cache[CONFIG_PATH];
  try {
    return require(CONFIG_PATH);
  } finally {
    delete require.cache[CONFIG_PATH];
    if (saved === undefined) delete process.env.SIMPLE_E2E_PORT;
    else process.env.SIMPLE_E2E_PORT = saved;
  }
}

// ---- The port ---------------------------------------------------------------
test('the browser tests do not use the preview port by default', () => {
  assert.notEqual(serverCheck.e2ePort({}), PREVIEW_PORT);
});

test('SIMPLE_E2E_PORT picks another port, so two checkouts can test at once', () => {
  assert.equal(serverCheck.e2ePort({ SIMPLE_E2E_PORT: '8901' }), 8901);
});

for (const bad of ['abc', '0', '70000', '80.5']) {
  test('SIMPLE_E2E_PORT=' + bad + ' is refused', () => {
    assert.throws(
      () => serverCheck.e2ePort({ SIMPLE_E2E_PORT: bad }),
      /SIMPLE_E2E_PORT/
    );
  });
}

// ---- The Playwright config --------------------------------------------------
test('the config never reuses a server that is already running', () => {
  assert.equal(loadConfig({}).webServer.reuseExistingServer, false);
});

test('the config starts its server and points the tests at the same port', () => {
  const config = loadConfig({ SIMPLE_E2E_PORT: '8901' });
  assert.match(config.webServer.command, /http\.server 8901 /);
  assert.equal(config.webServer.url, 'http://127.0.0.1:8901/simple/');
  assert.equal(config.use.baseURL, 'http://127.0.0.1:8901');
});

test('the config checks the server before any test runs', () => {
  const config = loadConfig({});
  assert.equal(path.basename(config.globalSetup), 'global-setup.js');
});

// ---- The server really reads this checkout ----------------------------------
// A tiny static server for one folder, standing in for `python3 -m
// http.server`.
function serveFolder(folder) {
  const server = http.createServer((request, response) => {
    const file = path.join(folder, decodeURIComponent(request.url));
    if (!fs.existsSync(file)) {
      response.writeHead(404).end('not found');
      return;
    }
    response.writeHead(200).end(fs.readFileSync(file));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const origin = 'http://127.0.0.1:' + server.address().port;
      resolve({ origin, close: () => server.close() });
    });
  });
}

function tempFolder(t) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-server-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  return folder;
}

test('a server that reads this folder passes the check', async (t) => {
  const folder = tempFolder(t);
  const server = await serveFolder(folder);
  t.after(server.close);
  await serverCheck.requireServerReadsFolder(server.origin, folder);
});

test('a server that reads another folder fails the check', async (t) => {
  const thisCheckout = tempFolder(t);
  const otherCheckout = tempFolder(t);
  const server = await serveFolder(otherCheckout);
  t.after(server.close);
  await assert.rejects(
    serverCheck.requireServerReadsFolder(server.origin, thisCheckout),
    /not serving this checkout/
  );
});

test('two checks of one folder at the same time both pass', async (t) => {
  // Two test runs in one checkout must not delete each other's token.
  const folder = tempFolder(t);
  const server = await serveFolder(folder);
  t.after(server.close);
  await Promise.all([
    serverCheck.requireServerReadsFolder(server.origin, folder),
    serverCheck.requireServerReadsFolder(server.origin, folder),
    serverCheck.requireServerReadsFolder(server.origin, folder),
  ]);
});

test('the check leaves no token file behind, pass or fail', async (t) => {
  const folder = tempFolder(t);
  const other = tempFolder(t);
  const good = await serveFolder(folder);
  const wrong = await serveFolder(other);
  t.after(good.close);
  t.after(wrong.close);
  await serverCheck.requireServerReadsFolder(good.origin, folder);
  await assert.rejects(
    serverCheck.requireServerReadsFolder(wrong.origin, folder)
  );
  assert.deepEqual(fs.readdirSync(folder), []);
});
