'use client';

import { ReactNode, useId } from 'react';

export interface TabDef<T extends string> {
  value: T;
  label: ReactNode;
  testId?: string;
}

/**
 * Underline tabs (a real WAI-ARIA tablist: roving tabindex, arrow/Home/End keys).
 * Panels are the caller's — pass the same `idPrefix` to `tabPanelProps` for aria wiring.
 */
export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  label,
  idPrefix,
}: {
  tabs: TabDef<T>[];
  value: T;
  onChange: (v: T) => void;
  label: string;
  idPrefix?: string;
}) {
  const auto = useId();
  const prefix = idPrefix ?? auto;

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const i = tabs.findIndex((t) => t.value === value);
    const rtl = getComputedStyle(e.currentTarget).direction === 'rtl';
    let next = i;
    if (e.key === (rtl ? 'ArrowLeft' : 'ArrowRight')) next = (i + 1) % tabs.length;
    else if (e.key === (rtl ? 'ArrowRight' : 'ArrowLeft')) next = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    else return;
    e.preventDefault();
    onChange(tabs[next].value);
    (e.currentTarget.querySelector(`[data-tab="${tabs[next].value}"]`) as HTMLElement | null)?.focus();
  }

  return (
    <div role="tablist" aria-label={label} onKeyDown={onKeyDown} className="flex gap-1 overflow-x-auto border-b border-ink-100">
      {tabs.map((tab) => {
        const active = tab.value === value;
        return (
          <button
            key={tab.value}
            id={`${prefix}-tab-${tab.value}`}
            type="button"
            role="tab"
            data-tab={tab.value}
            data-testid={tab.testId}
            aria-selected={active}
            aria-controls={`${prefix}-panel-${tab.value}`}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(tab.value)}
            className={`relative -mb-px whitespace-nowrap rounded-t-lg px-4 py-2.5 text-sm font-medium transition-colors ${
              active ? 'text-brand-700' : 'text-ink-500 hover:bg-sand-100 hover:text-ink-800'
            }`}
          >
            {tab.label}
            <span
              aria-hidden
              className={`absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-accent-500 transition-opacity ${active ? 'opacity-100' : 'opacity-0'}`}
            />
          </button>
        );
      })}
    </div>
  );
}

export const tabPanelProps = (prefix: string, value: string) => ({
  role: 'tabpanel' as const,
  id: `${prefix}-panel-${value}`,
  'aria-labelledby': `${prefix}-tab-${value}`,
});
