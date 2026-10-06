'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

/**
 * In-app light/dark/system switch — see docs/conventions/design-system.md
 * § Theme toggle. The choice is persisted to localStorage and applied as
 * `data-theme="light|dark"` on <html>; "system" removes the attribute so the
 * tokens' `prefers-color-scheme` block decides (the default on first visit).
 * Deliberately duplicated verbatim in apps/admin (no shared React package —
 * same reasoning as I18nProvider).
 */
export type ThemeChoice = 'light' | 'dark' | 'system';

export const THEME_STORAGE_KEY = 'mbn.theme';

/** Inline in <head> (see THEME_INIT_SCRIPT) so the right theme paints on the very first frame — no flash of the wrong palette before hydration. */
export const THEME_INIT_SCRIPT = `try{var t=localStorage.getItem('${THEME_STORAGE_KEY}');if(t==='light'||t==='dark')document.documentElement.setAttribute('data-theme',t)}catch(e){}`;

interface ThemeContextValue {
  theme: ThemeChoice;
  /** What is actually painted right now ("system" resolved against the OS preference). */
  resolved: 'light' | 'dark';
  setTheme: (theme: ThemeChoice) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function readStored(): ThemeChoice {
  try {
    const v = window.localStorage.getItem(THEME_STORAGE_KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

function systemPrefersDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // 'system' on the server and first client render (matches the SSR markup); the stored choice is read in an effect.
  const [theme, setThemeState] = useState<ThemeChoice>('system');
  const [systemDark, setSystemDark] = useState(false);

  useEffect(() => {
    setThemeState(readStored());
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    setSystemDark(mq.matches);
    const onChange = () => setSystemDark(systemPrefersDark());
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const setTheme = useCallback((next: ThemeChoice) => {
    setThemeState(next);
    const root = document.documentElement;
    if (next === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', next);
    try {
      if (next === 'system') window.localStorage.removeItem(THEME_STORAGE_KEY);
      else window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      /* storage blocked — the choice still applies for this page view */
    }
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({ theme, resolved: theme === 'system' ? (systemDark ? 'dark' : 'light') : theme, setTheme }),
    [theme, systemDark, setTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within a ThemeProvider');
  return ctx;
}
