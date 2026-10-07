'use client';

import { useEffect, useState } from 'react';

/**
 * Tracks `(prefers-reduced-motion: reduce)` live — the sidebar (7.3) gets this
 * for free via `motion-safe:` Tailwind classes, but the live analog clock
 * (step 8.1 Part 3, docs/conventions/attendance-ui.md) rotates its hands via
 * inline `style={{ transform }}`, which `motion-safe:` can't reach, so the
 * component itself needs to know whether to ease the sweep off.
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(query.matches);
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  return reduced;
}
