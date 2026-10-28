// Evaluates the dashboard's plain <script> files inside a sandbox so Node
// tests can call what each file publishes on `window`. The files are not
// modules: each one assigns window.DFS_CONFIG, window.DFS_TABLE or
// window.DFS_MAP and reads the others back from `window`, so the sandbox is
// its own `window` and the scripts run in order, like the <script> tags in
// simple/index.html.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const JS_DIR = path.resolve(__dirname, '..', 'js');

function readScript(name) {
  return fs.readFileSync(path.join(JS_DIR, name), 'utf8');
}

// `globals` is whatever the scripts should see besides the language
// built-ins: a `location`, a `document`, a Leaflet stub, a fetch mock.
function loadScripts(names, globals) {
  const sandbox = Object.assign({ URLSearchParams, console }, globals);
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  for (const name of names) {
    vm.runInContext(readScript(name), sandbox, { filename: name });
  }
  return sandbox;
}

module.exports = { loadScripts, readScript, JS_DIR };
