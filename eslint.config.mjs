// ESLint flat config for the SIREN dashboard frontend.
//
// The dashboard is plain browser JavaScript loaded with <script> tags, not
// modules. Each file publishes one object on `window` (DEFNS_CONFIG,
// DEFNS_MAP, ...) and reads the others from there, so `window` is the
// only cross-file surface and the files are linted as scripts.
import js from '@eslint/js';
import globals from 'globals';

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
    rules: {
      // Underscore-prefixed names are the project's convention for
      // intentionally unused parameters and private helpers.
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // The dashboard logs its load status on purpose; see OPERATIONS.md.
      'no-console': 'off',
    },
  },
  {
    ignores: ['node_modules/', 'alerts/data/', 'cache/'],
  },
];
