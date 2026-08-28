/**
 * Locale-correct display formatting — mirrors apps/portal/src/lib/format.ts,
 * thin wrappers over the native `Intl` APIs driven by the resolved Country
 * Pack's `locale` section, never a hardcoded "en-US". Modern Hermes (the
 * default RN JS engine, this SDK) ships full `Intl` support including
 * non-English locales, so no polyfill is needed here the way older RN/
 * Hermes versions once required (`@formatjs/intl-*` polyfills) — verify
 * this holds if the RN/Hermes version is ever downgraded.
 *
 * Timestamps render in the DEVICE'S OWN timezone (`Intl` reads it
 * automatically with no `timeZone` option) rather than re-fetching the
 * employee's branch timezone for display — the same deliberate
 * simplification the portal documents for itself: the backend's
 * timezone-correct `workDate` attribution (1.3) is authoritative
 * regardless of how a client renders it locally.
 */
const localeTag = (bcp47: string) => bcp47.replace('_', '-');

export function formatDate(iso: string | null | undefined, locale: string): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat(localeTag(locale), { year: 'numeric', month: 'short', day: 'numeric' }).format(new Date(iso));
}

export function formatDateTime(iso: string | null | undefined, locale: string): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat(localeTag(locale), {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(iso));
}

export function formatTime(iso: string | null | undefined, locale: string): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat(localeTag(locale), { hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
}

export function formatMinutesAsHours(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined) return '—';
  const sign = minutes < 0 ? '-' : '';
  const abs = Math.abs(minutes);
  const hours = Math.floor(abs / 60);
  const mins = abs % 60;
  return `${sign}${hours}h ${mins}m`;
}
