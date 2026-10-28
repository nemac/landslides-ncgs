// Browser smoke test for the DFENS Simple page. The page is served by the
// same Python static server the `static-site` launch config uses, from the
// repo root, so the fixtures under simple/test/fixtures/ are reachable
// through the page's ?data= override. Run with: npm run test:e2e
const path = require('node:path');
const { defineConfig } = require('@playwright/test');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const ORIGIN = 'http://127.0.0.1:8000';

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
  use: {
    baseURL: ORIGIN,
    browserName: 'chromium',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'python3 -m http.server 8000 --bind 127.0.0.1',
    cwd: REPO_ROOT,
    url: ORIGIN + '/simple/',
    reuseExistingServer: true,
    timeout: 20000,
  },
});
