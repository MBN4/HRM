/**
 * Canonical timestamp convention for the whole system: every timestamp is
 * STORED and passed between services in UTC (Prisma `DateTime` columns,
 * ISO-8601 strings in JSON payloads) — this module is the one sanctioned
 * place that converts a UTC instant into a specific IANA timezone for
 * display. See /CLAUDE.md § Conventions → i18n / timezone / RTL.
 *
 * Built on the native `Intl` API rather than a date-fns-tz/moment-timezone
 * dependency — Node's bundled ICU data already carries the full IANA
 * timezone database, so no extra package earns its weight here.
 */

export class InvalidTimeZoneError extends Error {
  constructor(timeZone: string) {
    super(`"${timeZone}" is not a recognized IANA timezone.`);
    this.name = 'InvalidTimeZoneError';
  }
}

/**
 * Throws `InvalidTimeZoneError` for a bogus timezone rather than silently
 * falling back to UTC — consistent with this project's "no missing_ok"
 * posture elsewhere (RLS's `current_setting`, Country Pack resolution's
 * `404` on an unresolved country).
 */
export function assertValidTimeZone(timeZone: string): void {
  try {
    // eslint-disable-next-line no-new
    new Intl.DateTimeFormat(undefined, { timeZone });
  } catch {
    throw new InvalidTimeZoneError(timeZone);
  }
}

export interface FormatInTimeZoneOptions {
  /** BCP-47 locale for month/weekday names and number formatting, e.g. "en", "ar". Defaults to "en". */
  locale?: string;
  dateStyle?: Intl.DateTimeFormatOptions['dateStyle'];
  timeStyle?: Intl.DateTimeFormatOptions['timeStyle'];
}

/**
 * Renders a UTC instant (a `Date`, or an ISO-8601 string as every API
 * response/DB read already is) in the given IANA timezone. This is the ONE
 * place `apps/api`/`apps/portal`/`apps/admin` should call to turn a stored
 * UTC timestamp into a user- or branch-local rendering — never hand-roll
 * timezone offset math elsewhere.
 */
export function formatInTimeZone(
  instant: Date | string,
  timeZone: string,
  options: FormatInTimeZoneOptions = {},
): string {
  assertValidTimeZone(timeZone);
  const date = typeof instant === 'string' ? new Date(instant) : instant;
  return new Intl.DateTimeFormat(options.locale ?? 'en', {
    timeZone,
    dateStyle: options.dateStyle ?? 'medium',
    timeStyle: options.timeStyle ?? 'short',
  }).format(date);
}

/** Always returns a UTC ISO-8601 string — the canonical wire format for every timestamp this system produces. */
export function toUtcIsoString(instant: Date | string): string {
  const date = typeof instant === 'string' ? new Date(instant) : instant;
  return date.toISOString();
}
