/**
 * Languages rendered right-to-left. Used only when a recipient's
 * `User.preferredLanguage` diverges from their resolved branch's Country
 * Pack (which already carries its own `locale.rtl` for its
 * `defaultLanguage`) — see NotificationLocaleResolverService. A small,
 * explicit whitelist rather than a full BCP-47/ICU directionality table,
 * matching this project's existing "don't build a general facility for a
 * one-off need" posture; extend it if a real RTL language shows up that
 * isn't here yet.
 */
const RTL_LANGUAGES = new Set(['ar', 'he', 'fa', 'ur']);

export function isRtlLanguage(language: string): boolean {
  return RTL_LANGUAGES.has(language.toLowerCase());
}
