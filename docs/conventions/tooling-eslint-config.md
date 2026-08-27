# Tooling: ESLint / pre-commit config

[← Back to CLAUDE.md](../../CLAUDE.md) · [Build log](../BUILD_LOG.md)

Unlike the other files in this directory, these conventions weren't
established by a single numbered step — they came out of two "pre-commit
lint tooling fixed" fixes on 2026-08-24, in between steps 0.2 and 0.3. See
[`docs/BUILD_LOG.md`](../BUILD_LOG.md) (the "Pre-commit lint tooling fixed"
and "Pre-commit lint tooling fixed again" entries) for the full incident
detail and verification notes — this file collects just the durable rules
those incidents produced, for quick reference when adding a new workspace.

- **Every new workspace's eslint config must set `root: true`.** Without
  it, ESLint's config cascade merges a closer-to-root config (including
  the repo's own root-level `.eslintrc.js` fallback, itself needed
  because `eslint`/`eslint-config-prettier` are root devDependencies with
  no workspace-local config of their own for plain-JS files like
  `packages/config`'s) into the workspace, which previously broke
  `apps/admin`/`apps/portal`'s build with a false-positive `no-undef` on
  `React.ReactNode` (a type-only reference) once the root config's
  `eslint:recommended` leaked in unexpectedly.
- **Any workspace eslint config that sets `parserOptions.project` MUST
  also add an `overrides` entry disabling `project` (set it to `null`)
  for that workspace's own non-source config/dot files** (`.eslintrc.js`
  itself, and any other root-level `*.js` config file in that workspace
  that isn't under its tsconfig's `include`). `@typescript-eslint/parser`
  type-checks every linted file against `tsconfig.json` once `project` is
  set, and a config file that isn't in that tsconfig's `include` fails to
  parse at all ("TSConfig does not include ...") — this bit
  `apps/api/.eslintrc.js` itself the moment it started setting `project`.
  The fix is the standard typescript-eslint `overrides` escape hatch,
  scoped to just the offending file(s); real source under `src/**/*.ts`
  must stay fully type-aware — confirm via `--print-config` after any
  change like this that `parserOptions.project` is unchanged for actual
  source files.
- **Test files get real type-aware linting like any other source — they
  belong in the base tsconfig's `include`, not nulled out via the
  `.eslintrc.js`-style `overrides` escape hatch above**, which is
  reserved for genuinely non-source config/dot files. Established in step
  0.3 when `apps/api/tsconfig.json`'s `include` was widened to cover
  `test/**/*.ts` (previously only `src/**/*.ts`) — `tsconfig.build.json`
  already excludes `test/`/`**/*spec.ts` independently, so this doesn't
  affect the production build, only linting/type-checking of tests
  themselves.
- ESLint's shareable-config name resolution mangles scoped-package
  subpaths (e.g. `@hrm/config/eslint-preset.js` in an `extends` array) —
  every `.eslintrc.js` that extends the shared preset must use
  `require.resolve('@hrm/config/eslint-preset.js')` instead of the bare
  specifier (noted originally in the 0.1 build log entry).
