'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * A label tooltip for the collapsed icon rail. It is PORTALLED + `position:
 * fixed` because the nav is `overflow-y: auto` (which would clip an absolutely
 * positioned child). Placed on the INLINE-END side of the icon, so it opens
 * toward the page content in both LTR and RTL. Shown on hover AND keyboard
 * focus (so it is reachable without a mouse). It is `aria-hidden`: the link's
 * own (visually collapsed) text already provides the accessible name.
 */
export function RailTooltip({ label, enabled, children }: { label: string; enabled: boolean; children: (props: TriggerProps) => React.ReactNode }) {
  const [pos, setPos] = useState<{ top: number; start: number; rtl: boolean } | null>(null);
  const anchorRef = useRef<HTMLElement | null>(null);
  const id = useId();

  const show = useCallback(() => {
    const el = anchorRef.current;
    if (!enabled || !el) return;
    const rect = el.getBoundingClientRect();
    const rtl = getComputedStyle(el).direction === 'rtl';
    // `start` is the distance from the viewport's inline-start edge... expressed as a physical offset:
    // LTR -> left = rect.right + gap ; RTL -> right = viewportWidth - rect.left + gap.
    const gap = 10;
    setPos({ top: rect.top + rect.height / 2, start: rtl ? window.innerWidth - rect.left + gap : rect.right + gap, rtl });
  }, [enabled]);
  const hide = useCallback(() => setPos(null), []);

  // Hide on Escape / scroll / when the rail expands.
  useEffect(() => {
    if (!pos) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setPos(null);
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', hide, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', hide, true);
    };
  }, [pos, hide]);
  useEffect(() => {
    if (!enabled) setPos(null);
  }, [enabled]);

  return (
    <>
      {children({
        ref: (node: HTMLElement | null) => {
          anchorRef.current = node;
        },
        onMouseEnter: show,
        onMouseLeave: hide,
        onFocus: show,
        onBlur: hide,
      })}
      {pos &&
        createPortal(
          <span
            id={id}
            aria-hidden="true"
            data-testid="sidebar-tooltip"
            style={{ position: 'fixed', top: pos.top, ...(pos.rtl ? { right: pos.start } : { left: pos.start }), transform: 'translateY(-50%)' }}
            className="pointer-events-none z-[70] whitespace-nowrap rounded-lg bg-ink-900 px-2.5 py-1.5 text-xs font-medium text-white shadow-pop motion-safe:animate-sidebar-tip-in rtl:motion-safe:animate-sidebar-tip-in-rtl"
          >
            {label}
          </span>,
          document.body,
        )}
    </>
  );
}

export interface TriggerProps {
  ref: (node: HTMLElement | null) => void;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onFocus: () => void;
  onBlur: () => void;
}
