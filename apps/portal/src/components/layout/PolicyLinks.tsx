'use client';

import Link from 'next/link';
import { useI18n } from '../../i18n/I18nProvider';

/** The privacy-policy link shown on the login screen and in the app footer (step 7.1) — see docs/conventions/user-management.md → Privacy policy page. */
export function PolicyLinks({ className = '' }: { className?: string }) {
  const { t } = useI18n();
  return (
    <p className={`text-xs ${className}`}>
      <Link href="/privacy-policy" className="underline-offset-2 hover:underline" data-testid="privacy-policy-link">
        {t('privacyPolicy.footerLink')}
      </Link>
    </p>
  );
}
