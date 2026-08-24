/**
 * Fallback config for plain JS files that have no closer workspace config to
 * cascade from — root-level config files (.prettierrc.js,
 * commitlint.config.js) and packages/config's own *.js files, which can't
 * extend the very preset they define. Every app/package under apps/* and
 * packages/{db,shared} has its own more specific .eslintrc.js/.json that
 * takes precedence for files inside it.
 *
 * `root: true` so ESLint stops climbing here instead of continuing past the
 * repo into a parent directory's config.
 */
module.exports = {
  root: true,
  env: {
    node: true,
    es2022: true,
  },
  extends: ['eslint:recommended', 'eslint-config-prettier'],
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'script',
  },
  ignorePatterns: [
    'node_modules',
    '**/node_modules/**',
    'dist',
    '**/dist/**',
    'build',
    '.next',
    '**/.next/**',
    '.turbo',
    '**/.turbo/**',
    'coverage',
    '**/coverage/**',
  ],
};
