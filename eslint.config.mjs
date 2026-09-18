import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/.turbo/**',
      '.tmp/**',
      // Durable state and run workspaces. They are written by the runtime at
      // run time: linting them lints whatever an example happened to execute,
      // and a stale workspace would fail CI with errors nobody wrote.
      '**/.kazi/**',
      '**/.agentos/**',
      // Fixture repositories. They are inputs to the examples - deliberately
      // CommonJS, deliberately not ours to restyle.
      'examples/*/repo/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parserOptions: { sourceType: 'module' },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': 'off',
      eqeqeq: ['error', 'always'],
      'prefer-const': 'error',
    },
  },
  {
    files: ['apps/dashboard/**/*.ts', 'apps/dashboard/**/*.tsx'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },
  {
    // Standalone Node scripts (test fixtures, tooling) run in the Node runtime.
    files: ['**/*.mjs', '**/*.cjs'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly', Buffer: 'readonly', __dirname: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly' },
    },
  },
);

