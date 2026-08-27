'use client';

import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { DEFAULT_LOCALE, directionFor, isRtlLanguage, SupportedLocale, translate } from '@hrm/shared';

/**
 * The web-app half of /CLAUDE.md § Conventions → i18n / timezone / RTL —
 * formalizes what was ad hoc: ONE `t()` translation function (reusing
 * `@hrm/shared`'s `translate`, the SAME `{{placeholder}}` substitution
 * mechanism `NotificationTemplateRenderer` (0.8) uses server-side) and ONE
 * place `dir`/`lang` are derived from, rather than each page re-deriving
 * its own.
 *
 * `dir` is derived from `locale` via `isRtlLanguage` — a reasonable
 * default for this UI-chrome layer, which has no per-tenant session to
 * resolve a real Country Pack from yet. A future session-aware
 * integration should prefer the AUTHORITATIVE signal instead — the
 * resolved effective Country Pack's own `locale.rtl` (via `GET
 * /country-packs/effective`, exactly what the API's own `GET /i18n/demo`
 * endpoint already proves end to end) — and pass it down as an explicit
 * `rtl` override rather than relying on this inference.
 *
 * Deliberately duplicated verbatim in `apps/admin/src/i18n/` rather than
 * factored into a shared package: this codebase has no shared REACT
 * package today (`packages/shared` is intentionally framework-agnostic —
 * DTOs/validators/utilities only), and creating one for ~50 lines used by
 * exactly two apps isn't earned yet. If a third app needs this, or the
 * provider grows real complexity, promote it to `packages/ui` then.
 */
export interface I18nContextValue {
  locale: SupportedLocale;
  dir: 'ltr' | 'rtl';
  t: (key: string, vars?: Record<string, unknown>) => string;
  setLocale: (locale: SupportedLocale) => void;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export interface I18nProviderProps {
  /**
   * The initially-resolved locale. Defaults to `DEFAULT_LOCALE` ("en")
   * until session-aware resolution is wired up here — see the module doc
   * comment above. Only the INITIAL value; use `useI18n().setLocale` to
   * change it afterwards (e.g. from a language switcher).
   */
  locale?: SupportedLocale;
  /** Optional authoritative override for `dir` — pass the resolved Country Pack's `locale.rtl` here once session resolution exists, instead of letting `dir` be inferred from `locale` alone. */
  rtl?: boolean;
  children: React.ReactNode;
}

export function I18nProvider({ locale: initialLocale = DEFAULT_LOCALE, rtl, children }: I18nProviderProps) {
  const [locale, setLocale] = useState<SupportedLocale>(initialLocale);
  const dir = directionFor(rtl ?? isRtlLanguage(locale));

  // Keeps <html lang dir> in sync client-side — the RootLayout's own
  // <html> tag ships a safe en/ltr default for the initial server render
  // (no session to resolve from at that layer yet), and this reconciles
  // it whenever the resolved/selected locale changes.
  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = dir;
  }, [locale, dir]);

  const value = useMemo<I18nContextValue>(
    () => ({ locale, dir, t: (key, vars) => translate(locale, key, vars), setLocale }),
    [locale, dir],
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
