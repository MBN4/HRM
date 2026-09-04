'use client';

import { useI18n } from '../../i18n/I18nProvider';
import { useBranding } from '../../lib/branding/BrandingProvider';

/**
 * The vendor-identity footer — hidden ONLY when the caller's tenant has
 * BOTH enabled full rebrand AND is currently entitled to it
 * (`PublicBranding.showPoweredBy`, computed server-side and re-derived
 * from the LIVE feature-flag entitlement on every read — see
 * docs/conventions/white-label.md). Mounted on the login screen and the
 * authenticated app shell (see (app)/layout.tsx) — the two surfaces a
 * "Powered by" identity would realistically appear on.
 */
export function PoweredByFooter({ className = '' }: { className?: string }) {
  const { t } = useI18n();
  const { branding, ready } = useBranding();

  if (!ready || !branding.showPoweredBy) {
    return null;
  }
  return (
    <p className={`text-xs ${className}`} data-testid="powered-by-footer">
      {t('branding.poweredBy')}
    </p>
  );
}
