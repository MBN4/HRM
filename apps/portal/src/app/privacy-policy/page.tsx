'use client';

import Link from 'next/link';
import { ArrowLeft, TriangleAlert } from 'lucide-react';
import { SUPPORTED_LOCALES } from '@hrm/shared';
import { useI18n } from '../../i18n/I18nProvider';
import { useAuth } from '../../lib/auth/AuthContext';
import { useBranding } from '../../lib/branding/BrandingProvider';
import { PRIVACY_POLICY_SECTIONS, PRIVACY_POLICY_VERSION } from '../../lib/privacy-policy-content';
import { formatDate } from '../../lib/format';
import { Wordmark } from '../../components/brand/Wordmark';
import { ThemeToggle } from '../../components/layout/ThemeToggle';

const LOCALE_LABELS: Record<string, string> = { en: 'English', ar: 'العربية' };

/**
 * The privacy-policy TEMPLATE page (step 7.1) — deliberately OUTSIDE the
 * `(app)` route group so it is reachable signed-out (the login footer links
 * here) as well as from the app footer. It uses the root-level
 * `<I18nProvider>` (so `dir`/`lang` flip with the language switch below) and
 * only static content: no API calls, no tenant data. See
 * docs/conventions/user-management.md → Privacy policy page.
 */
export default function PrivacyPolicyPage() {
  const { t, locale, setLocale } = useI18n();
  const { branding, logoUrl } = useBranding();
  const { user } = useAuth();
  const sections = PRIVACY_POLICY_SECTIONS[locale] ?? PRIVACY_POLICY_SECTIONS.en;
  const fill = (text: string) => text.replaceAll('{{product}}', branding.productName);

  return (
    <div className="min-h-screen bg-sand-50">
      <header className="border-b border-ink-100 bg-surface">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <Wordmark name={branding.productName} logoUrl={logoUrl} tint={branding.primaryColor} tone="color" />
          <div className="flex items-center gap-2">
            <div role="group" aria-label={t('privacyPolicy.language')} className="inline-flex items-center rounded-lg border border-ink-200 bg-surface p-0.5">
              {SUPPORTED_LOCALES.map((code) => (
                <button
                  key={code}
                  type="button"
                  lang={code}
                  aria-pressed={locale === code}
                  onClick={() => setLocale(code)}
                  data-testid={`policy-lang-${code}`}
                  className={`rounded-md px-2.5 py-1 text-xs font-semibold focus-visible:ring-2 focus-visible:ring-accent-500 ${
                    locale === code ? 'bg-primary text-white' : 'text-ink-600 hover:bg-ink-100'
                  }`}
                >
                  {LOCALE_LABELS[code] ?? code}
                </button>
              ))}
            </div>
            <ThemeToggle />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:py-10">
        <Link href={user ? '/dashboard' : '/login'} className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-brand-600 hover:text-brand-700 hover:underline">
          <ArrowLeft className="h-4 w-4 rtl:-scale-x-100" aria-hidden />
          {t('privacyPolicy.back')}
        </Link>

        <h1 className="page-title" data-testid="privacy-policy-title">
          {t('privacyPolicy.title')}
        </h1>
        <p className="mt-1 text-sm text-ink-500">{t('privacyPolicy.lastUpdated', { date: formatDate(PRIVACY_POLICY_VERSION, locale) })}</p>

        <div role="note" data-testid="privacy-policy-template-notice" className="mt-5 flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-600">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <div>
            <p className="font-semibold">{t('privacyPolicy.templateTitle')}</p>
            <p className="mt-0.5">{t('privacyPolicy.templateNotice')}</p>
          </div>
        </div>

        <div className="mt-8 grid gap-8 lg:grid-cols-[14rem_minmax(0,1fr)]">
          <nav aria-label={t('privacyPolicy.contents')} className="lg:sticky lg:top-6 lg:self-start">
            <p className="eyebrow pb-2">{t('privacyPolicy.contents')}</p>
            <ol className="space-y-1 text-sm">
              {sections.map((section) => (
                <li key={section.id}>
                  <a href={`#${section.id}`} className="block rounded-md px-2 py-1 text-ink-600 hover:bg-ink-100 hover:text-ink-900">
                    {section.title}
                  </a>
                </li>
              ))}
            </ol>
          </nav>

          <article className="min-w-0 space-y-8 rounded-xl2 border border-ink-100 bg-surface p-6 shadow-card sm:p-8" data-testid="privacy-policy-body">
            {sections.map((section) => (
              <section key={section.id} id={section.id} aria-labelledby={`${section.id}-h`} className="scroll-mt-6">
                <h2 id={`${section.id}-h`} className="text-base font-semibold tracking-tight text-ink-900">
                  {section.title}
                </h2>
                <div className="mt-2 space-y-3 text-sm leading-relaxed text-ink-700">
                  {section.paragraphs?.map((p) => <p key={p}>{fill(p)}</p>)}
                  {section.bullets && (
                    <ul className="list-disc space-y-1.5 ps-5 marker:text-ink-400">
                      {section.bullets.map((b) => (
                        <li key={b}>{fill(b)}</li>
                      ))}
                    </ul>
                  )}
                  {section.closing?.map((p) => <p key={p}>{fill(p)}</p>)}
                </div>
              </section>
            ))}
          </article>
        </div>
      </main>
    </div>
  );
}
