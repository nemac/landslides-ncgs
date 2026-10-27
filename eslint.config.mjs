// ESLint flat config for the plain-JavaScript parts of the repo.
//
// The SIREN dashboard (alerts/js) and the DFENS Simple dashboard (simple/js)
// are plain browser JavaScript loaded with <script> tags, not modules. Each
// file publishes one object on `window` (DEFNS_CONFIG, DEFNS_MAP, ...) and
// reads the others from there, so `window` is the only cross-file surface
// and the files are linted as scripts.
//
// infra/cloudfront holds CloudFront Function sources (the JS 2.0 runtime,
// roughly ES 2020, no modules) and Node test files for them. infra/cdk is
// TypeScript and is checked by its own `npm run typecheck`, not by ESLint.
import js from '@eslint/js';
import globals from 'globals';

// Shared rules for every block below.
const rules = {
  // Underscore-prefixed names are the project's convention for
  // intentionally unused parameters, catch bindings and private helpers.
  'no-unused-vars': [
    'error',
    {
      argsIgnorePattern: '^_',
      varsIgnorePattern: '^_',
      caughtErrorsIgnorePattern: '^_',
    },
  ],
  // The dashboards log their load status on purpose; see OPERATIONS.md.
  'no-console': 'off',
};

export default [
  js.configs.recommended,
  {
    files: ['alerts/js/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        ...globals.browser,
        // Third-party libraries loaded from CDN in alerts/index.html.
        L: 'readonly',
        turf: 'readonly',
      },
    },
    rules,
  },
  {
    files: ['simple/js/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        ...globals.browser,
        // Leaflet, loaded from CDN in simple/index.html.
        L: 'readonly',
      },
    },
    rules,
  },
  {
    // Node test files, run with `node --test`.
    files: ['simple/test/**/*.js', 'infra/cloudfront/test/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
      },
    },
    rules,
  },
  {
    // CloudFront Function sources: the JS 2.0 runtime, linted as scripts.
    // Each piece's top-level function (basicAuth, hostedRedirects, rewrite)
    // is called by the handler that infra/cdk/lib/compose-function.ts
    // appends, so only local variables are checked for use.
    files: ['infra/cloudfront/*.js'],
    languageOptions: {
      ecmaVersion: 2020,
      sourceType: 'script',
    },
    rules: {
      'no-unused-vars': [
        'error',
        { vars: 'local', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
  {
    ignores: [
      'node_modules/',
      'alerts/data/',
      'cache/',
      'infra/cdk/',
      '.venv/',
    ],
  },
];
