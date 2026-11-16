// Runs once, after Playwright has started the test server and before any
// test. It stops the run unless that server reads this checkout's files
// (see server-check.js for why).
const path = require('node:path');
const { e2ePort, requireServerReadsFolder } = require('./server-check.js');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

module.exports = async function globalSetup() {
  const origin = 'http://127.0.0.1:' + e2ePort(process.env);
  await requireServerReadsFolder(origin, REPO_ROOT);
};
