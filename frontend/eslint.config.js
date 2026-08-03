// Flat ESLint config. Tuned to catch BUGS rather than to enforce a house style — formatting
// arguments produce churn without preventing a single production incident, and this codebase
// already reads consistently.
import js from '@eslint/js';
import ts from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default [
  { ignores: ['dist/**', 'node_modules/**', '*.config.js'] },
  js.configs.recommended,
  ...ts.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: {
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: {
        window: 'readonly', document: 'readonly', navigator: 'readonly', location: 'readonly',
        localStorage: 'readonly', sessionStorage: 'readonly', fetch: 'readonly',
        setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly',
        clearInterval: 'readonly', console: 'readonly', alert: 'readonly', confirm: 'readonly',
        requestAnimationFrame: 'readonly', getComputedStyle: 'readonly', MutationObserver: 'readonly',
        HTMLElement: 'readonly', SVGSVGElement: 'readonly', Element: 'readonly', Event: 'readonly',
        KeyboardEvent: 'readonly', MouseEvent: 'readonly', AbortController: 'readonly',
        URLSearchParams: 'readonly', Blob: 'readonly', File: 'readonly', FormData: 'readonly',
        atob: 'readonly', btoa: 'readonly', crypto: 'readonly',
      },
    },
    rules: {
      // The hooks rules genuinely prevent broken renders and stale-closure bugs.
      ...reactHooks.configs.recommended.rules,
      // Underscore-prefixed args are a deliberate "unused on purpose" marker.
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // `any` is sometimes the honest type at an API boundary; warn, don't block.
      '@typescript-eslint/no-explicit-any': 'warn',
      // These catch real mistakes.
      eqeqeq: ['error', 'smart'],
      'no-var': 'error',
      'prefer-const': 'warn',
      'no-implicit-coercion': 'off',
    },
  },
];
