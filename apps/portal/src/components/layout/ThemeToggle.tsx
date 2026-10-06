'use client';

import { Monitor, Moon, Sun } from 'lucide-react';
import { useI18n } from '../../i18n/I18nProvider';
import { ThemeChoice, useTheme } from '../../lib/theme/ThemeProvider';

const OPTIONS: { value: ThemeChoice; icon: typeof Sun; key: string }[] = [
  { value: 'light', icon: Sun, key: 'theme.light' },
  { value: 'dark', icon: Moon, key: 'theme.dark' },
  { value: 'system', icon: Monitor, key: 'theme.system' },
];

/** Three-way segmented control (a radiogroup, arrow-key navigable). Logical spacing only, so it mirrors under RTL. */
export function ThemeToggle() {
  const { t } = useI18n();
  const { theme, setTheme } = useTheme();

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const dir = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    const i = OPTIONS.findIndex((o) => o.value === theme);
    const next = OPTIONS[(i + dir + OPTIONS.length) % OPTIONS.length];
    setTheme(next.value);
    (e.currentTarget.querySelector(`[data-theme-option="${next.value}"]`) as HTMLElement | null)?.focus();
  }

  return (
    <div
      role="radiogroup"
      aria-label={t('theme.label')}
      data-testid="theme-toggle"
      onKeyDown={onKeyDown}
      className="inline-flex items-center rounded-lg border border-ink-200 bg-surface p-0.5"
    >
      {OPTIONS.map(({ value, icon: Icon, key }) => {
        const active = theme === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={t(key)}
            title={t(key)}
            tabIndex={active ? 0 : -1}
            data-theme-option={value}
            data-testid={`theme-${value}`}
            onClick={() => setTheme(value)}
            className={`flex h-7 w-7 items-center justify-center rounded-md transition-colors ${
              active ? 'bg-primary text-white shadow-sm' : 'text-ink-500 hover:bg-sand-100 hover:text-ink-800'
            }`}
          >
            <Icon className="h-3.5 w-3.5" aria-hidden />
          </button>
        );
      })}
    </div>
  );
}
