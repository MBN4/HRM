'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

/** Rail (collapsed) width, the resizable range, and the first-visit default — all in px. */
export const SIDEBAR_RAIL_WIDTH = 72;
export const SIDEBAR_MIN_WIDTH = 224;
export const SIDEBAR_MAX_WIDTH = 360;
export const SIDEBAR_DEFAULT_WIDTH = 264;

interface Persisted {
  collapsed: boolean;
  width: number;
}

export interface SidebarContextValue {
  /** The user's saved preference (rail vs. full). On small screens the sidebar is a drawer and ignores this. */
  collapsed: boolean;
  /** Last expanded width (kept while collapsed so expanding restores it). */
  width: number;
  /** False until the saved state has been read — transitions are disabled until then so a reload never animates. */
  ready: boolean;
  /** `lg` and up: a resizable rail. Below: an overlay drawer. */
  isDesktop: boolean;
  mobileOpen: boolean;
  setCollapsed: (collapsed: boolean) => void;
  toggleCollapsed: () => void;
  setWidth: (width: number) => void;
  setMobileOpen: (open: boolean) => void;
}

const SidebarContext = createContext<SidebarContextValue | null>(null);

export function clampSidebarWidth(width: number): number {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)));
}

function read(storageKey: string): Persisted | null {
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Persisted>;
    return {
      collapsed: parsed.collapsed === true,
      width: typeof parsed.width === 'number' ? clampSidebarWidth(parsed.width) : SIDEBAR_DEFAULT_WIDTH,
    };
  } catch {
    return null; // private mode / blocked storage / corrupt JSON -> defaults
  }
}

/**
 * Owns the sidebar's persisted state. `storageKey` is per app
 * (`mbn.portal.sidebar.v1` / `mbn.admin.sidebar.v1`) so the two consoles
 * never share a preference. Everything storage-related is try/catch'd — the
 * sidebar must work with storage blocked.
 */
export function SidebarProvider({ storageKey, children }: { storageKey: string; children: React.ReactNode }) {
  const [collapsed, setCollapsedState] = useState(false);
  const [width, setWidthState] = useState(SIDEBAR_DEFAULT_WIDTH);
  const [ready, setReady] = useState(false);
  const [isDesktop, setIsDesktop] = useState(true);
  const [mobileOpen, setMobileOpen] = useState(false);

  // Read after mount (never during SSR) so server and first client render agree.
  useEffect(() => {
    const saved = read(storageKey);
    if (saved) {
      setCollapsedState(saved.collapsed);
      setWidthState(saved.width);
    }
    setReady(true);
  }, [storageKey]);

  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)');
    const sync = () => {
      setIsDesktop(mq.matches);
      if (mq.matches) setMobileOpen(false);
    };
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  const persist = useCallback(
    (next: Persisted) => {
      try {
        window.localStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        /* storage unavailable — the preference just won't survive a reload */
      }
    },
    [storageKey],
  );

  const setCollapsed = useCallback(
    (next: boolean) => {
      setCollapsedState(next);
      persist({ collapsed: next, width });
    },
    [persist, width],
  );

  const setWidth = useCallback(
    (next: number) => {
      const clamped = clampSidebarWidth(next);
      setWidthState(clamped);
      persist({ collapsed, width: clamped });
    },
    [persist, collapsed],
  );

  const value = useMemo<SidebarContextValue>(
    () => ({
      collapsed,
      width,
      ready,
      isDesktop,
      mobileOpen,
      setCollapsed,
      toggleCollapsed: () => setCollapsed(!collapsed),
      setWidth,
      setMobileOpen,
    }),
    [collapsed, width, ready, isDesktop, mobileOpen, setCollapsed, setWidth],
  );

  return <SidebarContext.Provider value={value}>{children}</SidebarContext.Provider>;
}

export function useSidebar(): SidebarContextValue {
  const ctx = useContext(SidebarContext);
  if (!ctx) throw new Error('useSidebar must be used inside <SidebarProvider>.');
  return ctx;
}
