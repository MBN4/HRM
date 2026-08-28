/**
 * Byte-identical duplicate of `@hrm/shared/src/i18n/rtl.ts` — see
 * src/constants/app.ts's doc comment for why. The AUTHORITATIVE RTL signal
 * is still the resolved Country Pack's `locale.rtl` (see
 * src/lib/session/SessionContext.tsx); this whitelist is only the fallback
 * for a bare language code with no pack attached.
 */
const RTL_LANGUAGES = new Set(['ar', 'he', 'fa', 'ur']);

export function isRtlLanguage(language: string): boolean {
  return RTL_LANGUAGES.has(language.toLowerCase());
}

export function directionFor(rtl: boolean): 'rtl' | 'ltr' {
  return rtl ? 'rtl' : 'ltr';
}
