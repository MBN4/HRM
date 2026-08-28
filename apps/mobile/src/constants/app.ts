/**
 * Precedent-duplicated from `@hrm/shared/src/constants/app.ts` rather than
 * imported — see metro.config.js's top comment and
 * docs/conventions/i18n-timezone-rtl.md's "~50 lines used by exactly two
 * apps doesn't earn a shared package yet" precedent (apps/portal's
 * I18nProvider.tsx vs. apps/admin's). This constant must stay byte-identical
 * to the source of truth; if it ever changes there, update it here too.
 */
export const TENANT_HEADER = 'x-tenant-id' as const;
