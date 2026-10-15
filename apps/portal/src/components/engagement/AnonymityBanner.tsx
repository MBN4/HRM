'use client';

import { Eye, ShieldCheck } from 'lucide-react';
import { useI18n } from '../../i18n/I18nProvider';

/** The prominent "is my name stored?" notice shown on every survey (taking + results) — the honest answer either way. */
export function AnonymityBanner({ anonymous }: { anonymous: boolean }) {
  const { t } = useI18n();
  const Icon = anonymous ? ShieldCheck : Eye;
  return (
    <div
      role="note"
      data-testid="anonymity-banner"
      data-anonymous={anonymous ? 'true' : 'false'}
      className={`flex items-start gap-3 rounded-xl border px-4 py-3 text-sm ${anonymous ? 'border-brand-200 bg-brand-50 text-brand-800' : 'border-sky-200 bg-sky-50 text-sky-700'}`}
    >
      <Icon className="mt-0.5 h-5 w-5 shrink-0" aria-hidden />
      <div>
        <p className="font-semibold">{anonymous ? t('survey.anonymous.title') : t('survey.identified.title')}</p>
        <p>{anonymous ? t('survey.anonymous.body') : t('survey.identified.body')}</p>
      </div>
    </div>
  );
}
