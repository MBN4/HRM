/**
 * Base ESLint config for TypeScript packages (NestJS apps, shared, db).
 * Next.js apps use `next/core-web-vitals` directly instead of this preset.
 */
module.exports = {
  root: false,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended', 'eslint-config-prettier'],
  env: {
    node: true,
    es2022: true,
  },
  ignorePatterns: ['dist', 'build', 'node_modules', '.next', '.turbo'],
  rules: {
    '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    '@typescript-eslint/no-explicit-any': 'warn',
  },
  overrides: [
    {
      // Plain-JS config files (.eslintrc.js, jest.config.js, jest.setup.js, etc.)
      // are CommonJS and aren't part of any tsconfig, so type-aware parsing and
      // the TS-only require() bans don't apply. Every workspace extending this
      // preset inherits correct config-file handling automatically.
      files: ['*.js'],
      parserOptions: {
        project: null,
      },
      rules: {
        '@typescript-eslint/no-require-imports': 'off',
        '@typescript-eslint/no-var-requires': 'off',
      },
    },
  ],
};
