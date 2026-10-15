'use client';

import { Delete } from 'lucide-react';
import { useI18n } from '../../i18n/I18nProvider';

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'] as const;
const KEY_CLASS =
  'flex h-16 select-none items-center justify-center rounded-2xl border border-ink-200 bg-surface text-2xl font-semibold text-ink-900 shadow-card transition-colors hover:bg-sand-100 active:bg-ink-100 disabled:opacity-50';

/**
 * A big, touch-first numeric keypad. The digit layout is ALWAYS left-to-right (`dir="ltr"`) — a keypad is a
 * physical-layout convention, not text, so it must not mirror under RTL (like a phone dialpad).
 */
export function PinPad({
  onDigit,
  onBackspace,
  onClear,
  disabled,
}: {
  onDigit: (d: string) => void;
  onBackspace: () => void;
  onClear: () => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  return (
    <div
      dir="ltr"
      className="grid grid-cols-3 gap-3"
      role="group"
      aria-label={t('kiosk.pad.label')}
      data-testid="kiosk-pad"
    >
      {KEYS.map((d) => (
        <button
          key={d}
          type="button"
          className={KEY_CLASS}
          disabled={disabled}
          onClick={() => onDigit(d)}
          data-testid={`kiosk-key-${d}`}
        >
          {d}
        </button>
      ))}
      <button
        type="button"
        className={`${KEY_CLASS} text-base`}
        disabled={disabled}
        onClick={onClear}
        data-testid="kiosk-key-clear"
      >
        {t('kiosk.pad.clear')}
      </button>
      <button
        type="button"
        className={KEY_CLASS}
        disabled={disabled}
        onClick={() => onDigit('0')}
        data-testid="kiosk-key-0"
      >
        0
      </button>
      <button
        type="button"
        className={KEY_CLASS}
        disabled={disabled}
        onClick={onBackspace}
        aria-label={t('kiosk.pad.backspace')}
        data-testid="kiosk-key-back"
      >
        <Delete className="h-7 w-7" aria-hidden />
      </button>
    </div>
  );
}
