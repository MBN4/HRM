/**
 * White-label / branding constants — step 4.3. See
 * docs/conventions/white-label.md.
 */

/**
 * THE brand name — the single source of truth for the product's own name.
 * Renaming the product is a ONE-LINE change here: `apps/portal`/`apps/admin`
 * (via their `lib/brand.ts`), the API's default `TenantBranding` resolution,
 * the UI message catalog's `app.name`/`branding.poweredBy`, and the default
 * outbound-email sender all derive from it. A tenant's own
 * `TenantBranding.productName` still overrides it at runtime.
 */
export const BRAND_NAME = 'MBN';

/** Fallback product name shown wherever a tenant hasn't set `TenantBranding.productName`. */
export const DEFAULT_PRODUCT_NAME: string = BRAND_NAME;

/** Default sender identity for outbound notification emails when a tenant hasn't set its own — see NotificationDeliveryService. */
export const DEFAULT_EMAIL_FROM_NAME: string = BRAND_NAME;
