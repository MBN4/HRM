const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

/**
 * pnpm-workspace-aware Metro config. This repo's root .npmrc sets
 * `shamefully-hoist=false`, so pnpm keeps each package's own dependencies
 * resolved via nested node_modules inside its `.pnpm` virtual store and
 * links cross-package/workspace deps via symlinks, rather than npm/yarn's
 * flat single-root hoisting.
 *
 * An earlier version of this file also set
 * `resolver.disableHierarchicalLookup = true`, following older Expo
 * monorepo guidance written for npm/yarn's hoisted layout. That setting
 * actively broke this pnpm layout: it stops Metro from walking up from a
 * package's own directory to find that PACKAGE's OWN nested node_modules
 * (e.g. `react-native`'s own dependency on `invariant`, which pnpm places
 * inside `react-native`'s private `.pnpm` node_modules, not hoisted
 * anywhere `disableHierarchicalLookup` + an explicit two-directory
 * `nodeModulesPaths` list could see) — confirmed by `npx expo export`
 * failing with "Unable to resolve module invariant" until this was
 * reverted. `npx expo-doctor` independently flags exactly this: it
 * expects `disableHierarchicalLookup: false` and
 * `unstable_enableSymlinks: undefined` (i.e., untouched) for a correctly
 * configured project on this Expo SDK — this SDK's own default Metro
 * config already understands pnpm's symlinked layout, and the extra
 * overrides only fought it. `watchFolders` is the one addition kept: it
 * lets Metro's file watcher see the rest of the monorepo (relevant if a
 * future change ever does import something from a workspace package).
 *
 * This app does NOT actually import `@hrm/shared` (see src/i18n, src/lib —
 * the handful of small pieces this app needs from it are deliberately
 * duplicated as plain literal TypeScript, the same precedent
 * apps/portal's I18nProvider.tsx sets over apps/admin's — see
 * docs/conventions/i18n-timezone-rtl.md's "~50 lines used by exactly two
 * apps doesn't earn a shared package yet"), precisely to avoid needing to
 * fight this exact class of pnpm/Metro resolution problem for a handful
 * of files.
 */
const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];

module.exports = config;
