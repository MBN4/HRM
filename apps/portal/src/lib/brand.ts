import { BRAND_NAME } from '@hrm/shared';

/**
 * The product's own name — re-exported from `@hrm/shared` (the single
 * source of truth, `packages/shared/src/constants/branding.ts`) so every
 * piece of UI chrome imports it from ONE place. Renaming the product is a
 * one-line change there. A tenant's own `TenantBranding.productName` (white-
 * label, 4.3) still overrides this at runtime wherever `useBranding()` is
 * available; this constant is the static fallback (tab titles, the
 * vendor console, pre-hydration render).
 */
export { BRAND_NAME };

export const PORTAL_TITLE = `${BRAND_NAME} Portal`;
