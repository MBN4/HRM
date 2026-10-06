'use client';

import { ReactNode, useId } from 'react';

/**
 * CSS-only hover/focus tooltip (no JS positioning, so nothing to flip under RTL — it is centered on the trigger).
 * The trigger keeps its own accessible name; the tip is `aria-describedby` supplementary text.
 */
export function Tooltip({ content, children, side = 'top' }: { content: ReactNode; children: ReactNode; side?: 'top' | 'bottom' }) {
  const id = useId();
  return (
    <span className="group/tip relative inline-flex" aria-describedby={id}>
      {children}
      <span
        id={id}
        role="tooltip"
        className={`pointer-events-none absolute start-1/2 z-40 w-max max-w-[16rem] -translate-x-1/2 rounded-md bg-sidebar px-2 py-1 text-xs font-medium text-sidebar-fg opacity-0 shadow-pop transition-opacity duration-150 group-hover/tip:opacity-100 group-focus-within/tip:opacity-100 rtl:translate-x-1/2 ${
          side === 'top' ? 'bottom-full mb-1.5' : 'top-full mt-1.5'
        }`}
      >
        {content}
      </span>
    </span>
  );
}
