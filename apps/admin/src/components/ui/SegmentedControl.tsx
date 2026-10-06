'use client';

import { ReactNode } from 'react';

/** Compact single-choice pill group (a radiogroup) — presets like the dashboard's 7d / 30d / 90d range. */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: { value: T; label: ReactNode; testId?: string }[];
  value: T;
  onChange: (v: T) => void;
  label: string;
}) {
  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const i = options.findIndex((o) => o.value === value);
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = options[(i + step + options.length) % options.length];
    onChange(next.value);
    (e.currentTarget.querySelector(`[data-seg="${next.value}"]`) as HTMLElement | null)?.focus();
  }
  return (
    <div role="radiogroup" aria-label={label} onKeyDown={onKeyDown} className="inline-flex rounded-lg border border-ink-200 bg-surface p-0.5 shadow-sm">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            data-seg={o.value}
            data-testid={o.testId}
            onClick={() => onChange(o.value)}
            className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${
              active ? 'bg-primary text-white shadow-sm' : 'text-ink-600 hover:bg-sand-100 hover:text-ink-900'
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
