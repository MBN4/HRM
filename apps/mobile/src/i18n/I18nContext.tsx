import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import * as SecureStore from 'expo-secure-store';
import { DEFAULT_LOCALE, SupportedLocale, translate } from './messages';
import { directionFor } from './rtl';

const LOCALE_KEY = 'hrm.locale';
const MANUAL_OVERRIDE_KEY = 'hrm.locale.manualOverride';

/**
 * Mirrors apps/portal's `I18nProvider.tsx` (see
 * docs/conventions/i18n-timezone-rtl.md) — `{ locale, dir, t, setLocale }`
 * — plus one mobile-specific wrinkle: the portal always defers to the
 * SESSION-resolved Country Pack `locale.defaultLanguage` (see
 * SessionProvider there); this app additionally lets a Settings-screen
 * choice WIN over that going forward, persisted across launches, since an
 * RTL flip here needs a full app reload (see useRtlSync.ts) and silently
 * reverting a user's explicit language choice back to the pack default on
 * every launch would be a worse experience than the portal's always-live
 * web page has to worry about. `applyResolvedLocale` (called by
 * SessionProvider once the effective Country Pack loads) is there for
 * exactly that portal-equivalent behavior — it's just skipped once the
 * user has ever explicitly chosen a language via `setLocale`.
 */
export interface I18nContextValue {
  locale: SupportedLocale;
  dir: 'rtl' | 'ltr';
  t: (key: string, vars?: Record<string, unknown>) => string;
  /** Explicit user choice (Settings screen) — persists and wins over any future Country-Pack-resolved default. */
  setLocale: (locale: SupportedLocale) => void;
  ready: boolean;
}

const I18nContext = createContext<I18nContextValue | null>(null);
/** Exposed only for SessionProvider — not part of the public useI18n() surface. */
export const InternalI18nContext = I18nContext;

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<SupportedLocale>(DEFAULT_LOCALE);
  const [ready, setReady] = useState(false);
  const manualOverrideRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [storedLocale, manualFlag] = await Promise.all([
          SecureStore.getItemAsync(LOCALE_KEY),
          SecureStore.getItemAsync(MANUAL_OVERRIDE_KEY),
        ]);
        if (cancelled) return;
        manualOverrideRef.current = manualFlag === '1';
        if (storedLocale === 'en' || storedLocale === 'ar') {
          setLocaleState(storedLocale);
        }
      } catch {
        // No persisted preference (or SecureStore unavailable) — DEFAULT_LOCALE stands.
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const setLocale = useCallback((next: SupportedLocale) => {
    manualOverrideRef.current = true;
    setLocaleState(next);
    SecureStore.setItemAsync(LOCALE_KEY, next).catch(() => {});
    SecureStore.setItemAsync(MANUAL_OVERRIDE_KEY, '1').catch(() => {});
  }, []);

  /** Called by SessionProvider once the effective Country Pack resolves — a no-op if the user has ever manually chosen a language via setLocale(). */
  const applyResolvedLocale = useCallback((next: SupportedLocale) => {
    if (manualOverrideRef.current) return;
    setLocaleState(next);
    SecureStore.setItemAsync(LOCALE_KEY, next).catch(() => {});
  }, []);

  const t = useCallback((key: string, vars: Record<string, unknown> = {}) => translate(locale, key, vars), [locale]);

  const value = useMemo<I18nContextValue & { applyResolvedLocale: (l: SupportedLocale) => void }>(
    () => ({ locale, dir: directionFor(locale === 'ar'), t, setLocale, ready, applyResolvedLocale }),
    [locale, t, setLocale, ready, applyResolvedLocale],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    throw new Error('useI18n() must be used within an <I18nProvider>.');
  }
  return ctx;
}

/** Internal escape hatch for SessionProvider only — see applyResolvedLocale's doc comment above. */
export function useApplyResolvedLocale(): (locale: SupportedLocale) => void {
  const ctx = useContext(I18nContext) as (I18nContextValue & { applyResolvedLocale: (l: SupportedLocale) => void }) | null;
  if (!ctx) {
    throw new Error('useApplyResolvedLocale() must be used within an <I18nProvider>.');
  }
  return ctx.applyResolvedLocale;
}
