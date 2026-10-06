import { BRAND_NAME } from '@hrm/shared';

/**
 * The product's own name — re-exported from `@hrm/shared` (the single
 * source of truth, `packages/shared/src/constants/branding.ts`). Renaming
 * the product is a one-line change there.
 */
export { BRAND_NAME };

export const CONSOLE_TITLE = `${BRAND_NAME} Vendor Console`;
