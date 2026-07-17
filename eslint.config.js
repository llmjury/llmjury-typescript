import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// ESLint 9 flat config (the legacy .eslintrc format is removed in v9).
//
// `no-undef` is intentionally left to the TypeScript compiler for `.ts` files (typescript-eslint
// disables it in its recommended set). For the plain `.mjs` scripts/examples we declare the handful
// of Node/Web globals they touch so they lint clean without pulling in the `globals` package.
const nodeWebGlobals = {
  process: 'readonly',
  console: 'readonly',
  Date: 'readonly',
  URL: 'readonly',
  fetch: 'readonly',
  setTimeout: 'readonly',
  Math: 'readonly',
};

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['scripts/**/*.mjs', 'examples/**/*.mjs', '*.js', '*.mjs'],
    languageOptions: { sourceType: 'module', globals: nodeWebGlobals },
  },
  {
    // Underscore-prefixed parameters are deliberately unused (e.g. test doubles
    // matching a real call signature).
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
);
