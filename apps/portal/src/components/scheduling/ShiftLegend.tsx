'use client';

import { CalendarOff, Plane } from 'lucide-react';
import { useI18n } from '../../i18n/I18nProvider';
import type { GridShift } from '../../lib/api/scheduling';
import { ShiftChip } from './ShiftChip';

/** Legend for the roster: the tenant's shifts plus how draft / standing / off / leave / weekend cells look. */
export function ShiftLegend({ shifts }: { shifts: GridShift[] }) {
  const { t } = useI18n();
  const swatch = 'inline-flex h-5 w-8 items-center justify-center rounded border text-ink-600';
  return (
    <section aria-label={t('scheduling.legend.title')} data-testid="roster-legend" className="space-y-2">
      <h3 className="eyebrow text-ink-400">{t('scheduling.legend.title')}</h3>
      <ul className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-ink-600">
        {shifts.map((s) => (
          <li key={s.id}>
            <ShiftChip name={s.name} color={s.color} startTime={s.startTime} endTime={s.endTime} />
          </li>
        ))}
        {shifts.length === 0 && <li className="text-ink-400">{t('scheduling.legend.noShifts')}</li>}
      </ul>
      <ul className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-ink-600">
        <li className="flex items-center gap-1.5">
          <span
            className={`${swatch} border-dashed border-ink-400`}
            style={{ backgroundImage: 'repeating-linear-gradient(135deg, rgb(var(--c-ink-400) / 0.28) 0, rgb(var(--c-ink-400) / 0.28) 2px, transparent 2px, transparent 7px)' }}
            aria-hidden
          />
          {t('scheduling.legend.draft')}
        </li>
        <li className="flex items-center gap-1.5">
          <span className={`${swatch} border-dotted border-ink-400 bg-ink-100/50`} aria-hidden />
          {t('scheduling.legend.standing')}
        </li>
        <li className="flex items-center gap-1.5">
          <span className={`${swatch} border-dashed border-ink-300 bg-sand-100`} aria-hidden>
            <CalendarOff className="h-3 w-3" />
          </span>
          {t('scheduling.cell.dayOff')}
        </li>
        <li className="flex items-center gap-1.5">
          <span className={`${swatch} border-sky-200 bg-sky-50 text-sky-700`} aria-hidden>
            <Plane className="h-3 w-3" />
          </span>
          {t('scheduling.cell.LEAVE')}
        </li>
        <li className="flex items-center gap-1.5">
          <span className={`${swatch} border-transparent bg-sand-100`} aria-hidden />
          {t('scheduling.legend.nonWorking')}
        </li>
      </ul>
    </section>
  );
}
