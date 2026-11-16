// Browser smoke test for the DFENS Simple page. The page is served by a
// Python static server from the repo root, like the `static-site` launch
// config, so the fixtures under simple/test/fixtures/ are reachable
// through the page's ?data= override. Run with: npm run test:e2e
//
// The tests start their own server on their own port (8765, or
// SIMPLE_E2E_PORT), never reuse one that is already running, and check
// that it reads this checkout before any test runs. server-check.js says
// why.
const path = require('node:path');
const { defineConfig } = require('@playwright/test');
const { e2ePort } = require('./server-check.js');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PORT = e2ePort(process.env);
const ORIGIN = 'http://127.0.0.1:' + PORT;

module.exports = defineConfig({
  testDir: __dirname,
  testMatch: /.*\.spec\.js$/,
  timeout: 30000,
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [
        ['list'],
        [
          'html',
          {
            open: 'never',
            outputFolder: path.join(REPO_ROOT, 'playwright-report'),
          },
        ],
      ]
    : 'list',
  outputDir: path.join(REPO_ROOT, 'test-results'),
  globalSetup: path.join(__dirname, 'global-setup.js'),
  use: {
    baseURL: ORIGIN,
    browserName: 'chromium',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'python3 -m http.server ' + PORT + ' --bind 127.0.0.1',
    cwd: REPO_ROOT,
    url: ORIGIN + '/simple/',
    // With false, Playwright stops with an error when the port is taken,
    // instead of testing whatever is already there.
    reuseExistingServer: false,
    timeout: 20000,
  },
});
