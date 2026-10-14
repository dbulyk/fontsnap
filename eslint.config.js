import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/', 'extension/ort/', 'out/', 'dist/', 'data/', 'python/'] },
  js.configs.recommended,
  {
    files: ['extension/**/*.js'],
    languageOptions: { sourceType: 'module', globals: { ...globals.browser, ...globals.serviceworker, chrome: 'readonly' } },
  },
  { files: ['extension/select.js'], languageOptions: { sourceType: 'script' } },
  { files: ['scripts/**/*.mjs', 'tests/**/*.mjs', 'eslint.config.js'], languageOptions: { sourceType: 'module', globals: globals.node } },
  { rules: { 'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }] } },
];
