import js from '@eslint/js';

const nodeGlobals = {
  console: 'readonly',
  process: 'readonly',
  Buffer: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  AbortController: 'readonly',
  fetch: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  structuredClone: 'readonly',
  queueMicrotask: 'readonly',
};

const browserGlobals = {
  window: 'readonly',
  document: 'readonly',
  navigator: 'readonly',
  location: 'readonly',
  crypto: 'readonly',
  CustomEvent: 'readonly',
  XMLHttpRequest: 'readonly',
  Blob: 'readonly',
  HTMLElement: 'readonly',
  MutationObserver: 'readonly',
};

export default [
  {
    ignores: ['node_modules/**', 'coverage/**'],
  },
  {
    ...js.configs.recommended,
    files: ['src/**/*.js'],
    languageOptions: {
      ...js.configs.recommended.languageOptions,
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: nodeGlobals,
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
    },
  },
  {
    files: ['src/core/ports/**/*.js'],
    rules: {
      'no-unused-vars': 'off',
    },
  },
  {
    files: ['src/sdk/**/*.js'],
    languageOptions: {
      globals: {
        ...nodeGlobals,
        ...browserGlobals,
      },
    },
  },
];
