/**
 * White-label / branding constants — step 4.3. See
 * docs/conventions/white-label.md.
 */

/** Fallback product name shown wherever a tenant hasn't set `TenantBranding.productName` — the same literal `apps/portal`/`apps/mobile`'s `UI_MESSAGES['app.name']` already ship as their own default. */
export const DEFAULT_PRODUCT_NAME = 'HRM';

/** Default sender identity for outbound notification emails when a tenant hasn't set its own — see NotificationDeliveryService. */
export const DEFAULT_EMAIL_FROM_NAME = 'HRM';
