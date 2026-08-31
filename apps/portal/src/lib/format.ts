/**
 * Locale-correct display formatting — thin wrappers over the native `Intl`
 * APIs (no date-fns/moment dependency, matching `@hrm/shared`'s own
 * `formatInTimeZone` posture) driven by the resolved Country Pack's
 * `locale` section, never a hardcoded "en-US". See
 * docs/conventions/frontend-ess-mss.md → "Locale-correct rendering".
 *
 * Timestamps are rendered in the VIEWER'S OWN BROWSER TIMEZONE (Intl reads
 * it automatically when no `timeZone` option is passed) rather than
 * re-fetching the employee's branch timezone for display purposes — a
 * deliberate, documented simplification: the person viewing their own
 * attendance is typically physically in that same timezone, and the
 * backend's timezone-correct `workDate` attribution (1.3) is authoritative
 * regardless of how a client happens to render it locally.
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

export function formatNumber(value: number, locale: string): string {
  return new Intl.NumberFormat(localeTag(locale)).format(value);
}

export function formatPercent(ratio: number, locale: string): string {
  return new Intl.NumberFormat(localeTag(locale), { style: 'percent', maximumFractionDigits: 1 }).format(ratio);
}

export function formatCurrency(amount: number, currencyCode: string | null | undefined, locale: string): string {
  if (!currencyCode) return formatNumber(amount, locale);
  try {
    return new Intl.NumberFormat(localeTag(locale), { style: 'currency', currency: currencyCode }).format(amount);
  } catch {
    return `${formatNumber(amount, locale)} ${currencyCode}`;
  }
}

/** Minutes -> "7h 30m" (or the RTL-safe reverse order is handled by the caller wrapping this in a `dir`-neutral span — this string itself has no directional punctuation). */
export function formatMinutesAsHours(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined) return '—';
  const sign = minutes < 0 ? '-' : '';
  const abs = Math.abs(minutes);
  const hours = Math.floor(abs / 60);
  const mins = abs % 60;
  return `${sign}${hours}h ${mins}m`;
}
