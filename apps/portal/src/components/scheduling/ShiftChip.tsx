'use client';

import { Moon } from 'lucide-react';
import { useI18n } from '../../i18n/I18nProvider';
import { isOvernight, tint } from '../../lib/scheduling';

/** Shift time range, always LTR-isolated; an overnight shift (end <= start) gets a moon + "+1" so it can never be misread. */
export function ShiftTimes({ startTime, endTime, className = '' }: { startTime: string; endTime: string; className?: string }) {
  const { t } = useI18n();
  const overnight = isOvernight(startTime, endTime);
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap tabular-nums ${className}`} data-overnight={overnight ? 'true' : 'false'}>
      <bdi dir="ltr">
        {startTime}–{endTime}
      </bdi>
      {overnight && (
        <span className="inline-flex items-center gap-0.5 text-[0.65rem] font-semibold" title={t('scheduling.overnight')}>
          <Moon className="h-3 w-3" aria-hidden />
          <bdi dir="ltr" aria-hidden>+1</bdi>
          <span className="sr-only">{t('scheduling.overnight')}</span>
        </span>
      )}
    </span>
  );
}

/** A colour swatch + name (+ times). The shift's own colour is a tinted background; text stays the theme's ink so contrast holds in light and dark. */
export function ShiftChip({
  name,
  color,
  startTime,
  endTime,
  className = '',
  testId,
}: {
  name: string;
  color: string | null;
  startTime?: string;
  endTime?: string;
  className?: string;
  testId?: string;
}) {
  return (
    <span
      data-testid={testId}
      className={`inline-flex max-w-full items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium text-ink-900 ${className}`}
      style={{ backgroundColor: tint(color), borderInlineStart: `3px solid ${color ?? '#2e9e7e'}` }}
    >
      <span className="truncate ps-1">{name}</span>
      {startTime && endTime && <ShiftTimes startTime={startTime} endTime={endTime} className="shrink-0 text-ink-600" />}
    </span>
  );
}
