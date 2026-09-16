'use client';

import { X } from 'lucide-react';
import { useEffect, useId, useRef } from 'react';

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // WCAG 2.4.3 (focus order) / 2.1.2 (no keyboard trap done wrong): move
    // focus INTO the dialog on open and restore it to whatever triggered
    // the modal on close, and keep Tab/Shift+Tab cycling within the panel
    // while open — axe's static scan can't catch either (both are runtime
    // focus-management behavior), but a screen-reader/keyboard-only user
    // would otherwise lose their place entirely.
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const firstFocusable = panelRef.current?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
    (firstFocusable ?? panelRef.current)?.focus();

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key !== 'Tab' || !panelRef.current) return;
      const focusable = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      previouslyFocused?.focus();
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/40 p-4" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <div ref={panelRef} tabIndex={-1} className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl2 bg-white shadow-soft outline-none">
        <div className="flex items-center justify-between border-b border-ink-100 px-5 py-4">
          <h2 id={titleId} className="text-sm font-semibold text-ink-900">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close dialog"
            className="rounded-md p-1 text-ink-400 hover:bg-ink-100 hover:text-ink-700"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
        <div className="px-5 py-4">{children}</div>
      </div>
    </div>
  );
}
