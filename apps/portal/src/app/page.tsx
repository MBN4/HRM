'use client';

import { useI18n } from '../i18n/I18nProvider';

/**
 * Proves the i18n/RTL wiring end to end in the browser: `t()` renders the
 * catalog string for the current locale, and switching locale flips
 * `<html dir>` (see I18nProvider) — toggle to "ar" to see the whole page
 * mirror right-to-left, the same behavior a resolved Qatar Country Pack
 * should eventually drive automatically once session resolution exists.
 */
export default function PortalHome() {
  const { locale, dir, t, setLocale } = useI18n();

  return (
    <main>
      <h1>{t('app.name')}</h1>
      <p>{t('common.welcome', { name: 'there' })}</p>
      <p>
        Tenant organization portal — scaffold. Current locale: <strong>{locale}</strong> (dir: {dir})
      </p>
      <button type="button" onClick={() => setLocale(locale === 'en' ? 'ar' : 'en')}>
        English / عربي
      </button>
    </main>
  );
}
