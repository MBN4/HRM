/**
 * Canonical RTL-language whitelist for the whole system — see /CLAUDE.md §
 * Conventions → i18n / timezone / RTL. The AUTHORITATIVE RTL signal for
 * rendering is always a resolved Country Pack's `locale.rtl` (set
 * per-country by whoever authors that pack, e.g. `true` for Qatar's Arabic
 * pack) — this whitelist exists only for the few places a bare BCP-47
 * language code needs a directionality guess with no pack attached (e.g.
 * `User.preferredLanguage` overriding a resolved pack's language — see
 * `apps/api/src/notifications/notification-locale-resolver.service.ts`).
 * Deliberately a small, explicit set rather than a full BCP-47/ICU
 * directionality table, matching this project's existing "don't build a
 * general facility for a one-off need" posture; extend it if a real RTL
 * language shows up that isn't here yet.
 */
const RTL_LANGUAGES = new Set(['ar', 'he', 'fa', 'ur']);

export function isRtlLanguage(language: string): boolean {
  return RTL_LANGUAGES.has(language.toLowerCase());
}

/** `"rtl"` / `"ltr"` — the literal value the web apps set on `<html dir>`. */
export function directionFor(rtl: boolean): 'rtl' | 'ltr' {
  return rtl ? 'rtl' : 'ltr';
}
