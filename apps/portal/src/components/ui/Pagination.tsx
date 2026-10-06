'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useI18n } from '../../i18n/I18nProvider';

/** Prev / "Page x of y" / Next. The chevrons mirror under RTL via `rtl:-scale-x-100`. */
export function Pagination({ page, pageCount, onChange }: { page: number; pageCount: number; onChange: (page: number) => void }) {
  const { t } = useI18n();
  if (pageCount <= 1) return null;
  const btn =
    'inline-flex items-center gap-1 rounded-lg border border-ink-200 bg-surface px-3 py-1.5 text-xs font-semibold text-ink-700 shadow-sm transition-colors hover:border-ink-300 hover:bg-sand-100 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-surface';
  return (
    <nav aria-label="Pagination" className="flex items-center justify-between gap-3 pt-3">
      <button type="button" className={btn} disabled={page <= 1} onClick={() => onChange(page - 1)}>
        <ChevronLeft className="h-3.5 w-3.5 rtl:-scale-x-100" aria-hidden />
        {t('ui.pagination.prev')}
      </button>
      <span className="text-xs text-ink-500">{t('ui.pagination.pageOf', { page, total: pageCount })}</span>
      <button type="button" className={btn} disabled={page >= pageCount} onClick={() => onChange(page + 1)}>
        {t('ui.pagination.next')}
        <ChevronRight className="h-3.5 w-3.5 rtl:-scale-x-100" aria-hidden />
      </button>
    </nav>
  );
}
