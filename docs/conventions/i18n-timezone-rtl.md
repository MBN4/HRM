# i18n / timezone / RTL

[← Back to CLAUDE.md](../../CLAUDE.md) · [Build log](../BUILD_LOG.md)

Defined in step 0.9 — `packages/shared/src/i18n`, `apps/api/src/common/i18n`,
`apps/portal`, `apps/admin`. See [`docs/BUILD_LOG.md`](../BUILD_LOG.md) (the
"0.9 audit logging, custom fields, i18n" entry) for the full file list and
verification notes. Formalizes what was ad hoc since 0.5 (Country Pack
`locale`, see [country-packs.md](./country-packs.md)) and 0.8 (notification
template rendering, see [notifications-queues.md](./notifications-queues.md))
into one canonical convention every future module should follow, rather than
re-deriving its own.

- **Timestamps: UTC in, UTC through, local at the very last step only.**
  Every timestamp is STORED (Prisma `DateTime` columns) and TRANSMITTED
  (JSON, `Date#toISOString()`) in UTC — this was already true everywhere
  in this codebase, now made an explicit, documented rule.
  `@hrm/shared`'s `formatInTimeZone(instant, timeZone, options)` (built
  on the native `Intl.DateTimeFormat` — Node's bundled ICU already
  carries the full IANA database, no date-fns-tz/moment-timezone
  dependency earns its weight here) is the ONE sanctioned place a UTC
  instant becomes a specific timezone's rendering; `assertValidTimeZone`
  throws `InvalidTimeZoneError` for a bogus zone rather than silently
  falling back to UTC, the same "no `missing_ok`" posture as RLS's
  `current_setting`/Country Pack resolution's `404` (see
  [tenancy-rls.md](./tenancy-rls.md), [country-packs.md](./country-packs.md)).
  `apps/api/src/common/i18n/timezone.service.ts`'s `TimezoneService` is
  the thin API-layer wrapper (`resolveBranchTimezone` reads the
  existing `Branch.timezone` column, set since 0.2); there is no
  per-user timezone column yet — branch timezone is today's only
  resolvable source, a future profile module can add a user-level
  override the same way `User.preferredLanguage` (0.8) overrides a
  resolved pack's language.
- **RTL: the Country Pack's `locale.rtl` is authoritative; a bare
  language-code whitelist is the fallback.** `@hrm/shared/src/i18n/rtl.ts`
  (formerly `notifications/rtl-languages.ts` — moved and generalized
  here since it's no longer notification-hub-specific; the one existing
  caller, `NotificationLocaleResolverService`, is unaffected since it
  only ever imported the barrel export) still exports `isRtlLanguage`
  for the same one-off it always had (a `User.preferredLanguage`
  override with no pack attached), plus a new `directionFor(rtl):
'rtl' | 'ltr'` used everywhere a boolean needs to become the literal
  value `<html dir>` expects. **`GET /i18n/demo`**
  (`apps/api/src/common/i18n/i18n-demo.controller.ts`) is this step's
  proof endpoint, in the same "demo endpoint proving a cross-cutting
  mechanism with no dedicated entity to hang it off of" role as `GET
/auth/rbac-demo`/`GET /tenancy/permission-field-demo`/`GET
/licensing/demo/advanced-reporting` — it reuses
  `CountryPackResolutionService` (0.5) for locale/RTL rather than
  re-deriving it, the same reuse `NotificationLocaleResolverService`
  (0.8) already established, and `TimezoneService` for rendering, proving
  a US branch and a Qatar branch resolve opposite `locale`/`rtl`/
  `direction` through the SAME endpoint while the underlying `nowUtc`
  stays identical.
- **String externalization — TWO catalogs, deliberately not unified into
  one.** `NotificationTemplate` (0.8, DB-stored, tenant-facing,
  versioned, vendor-authored COPY — emails, in-app notification text; see
  [notifications-queues.md](./notifications-queues.md)) is UNCHANGED by
  this step. `@hrm/shared/src/i18n/messages.ts`'s `UI_MESSAGES`/
  `translate()` is NEW: application CHROME (button labels, nav items,
  generic error text) for `apps/portal`/`apps/admin` — ordinary UI
  strings that ship with the code like any other source file, not
  tenant- or admin-editable data. Forcing these into one mechanism would
  be the wrong abstraction (one is runtime tenant data, the other is
  build-time source); what IS unified is the substitution mechanism
  itself — `@hrm/shared/src/i18n/interpolate.ts`'s `interpolateTemplate`
  (the `{{placeholder}}` regex substitution originally written for
  `NotificationTemplateRenderer`, promoted here so BOTH catalogs share
  exactly one templating syntax in this codebase, not two;
  `apps/api/src/notifications/notification-template-renderer.service.ts`
  was updated to call the shared function instead of its own private
  copy, with no behavior change). A UI string missing from a locale
  falls back to `DEFAULT_LOCALE` ("en"); missing from EVERY locale
  renders visibly as `[[key]]` rather than silently as empty text —
  DIFFERENT from `NotificationTemplateRenderer`'s server-side posture
  (a fully-missing template is a loud `404`, surfacing as a dead-lettered
  job): a missing UI string must never crash rendering, so this layer is
  deliberately more forgiving.
- **Web apps: one `I18nProvider` per app, duplicated verbatim rather
  than factored into a shared package.** `apps/portal/src/i18n/
I18nProvider.tsx` and `apps/admin/src/i18n/I18nProvider.tsx` are
  byte-identical: a React context exposing `{ locale, dir, t, setLocale
}`, `dir` derived from `locale` via `isRtlLanguage` (a reasonable
  default for UI chrome with no per-tenant session to resolve a real
  Country Pack from yet — an optional `rtl` prop lets a future
  session-aware integration override it with the AUTHORITATIVE
  `locale.rtl` from `GET /country-packs/effective` instead), and a
  `useEffect` that reconciles `document.documentElement.lang`/`dir`
  whenever locale changes. `RootLayout` in both apps ships a safe
  `lang="en" dir="ltr"` initial server render (no session to resolve
  from at that layer yet) wrapped in `<I18nProvider>`; each app's home
  page demonstrates `useI18n()` (`t('app.name')`, a locale-toggle
  button flipping the whole page RTL). Not factored into a shared
  package because this codebase has no shared REACT package today
  (`packages/shared` is intentionally framework-agnostic) and ~50 lines
  used by exactly two apps doesn't earn one yet — promote to a real
  `packages/ui` if a third app needs this or the provider grows real
  complexity.
- Verified: `apps/api/src/common/i18n/timezone.spec.ts` (pure unit
  tests — the same UTC instant renders differently per IANA timezone,
  respects the `locale` option, rejects a bogus timezone loudly, accepts
  both a `Date` and an ISO string) and
  `apps/api/test/i18n-demo.e2e-spec.ts` (3 e2e tests over real HTTP: a
  US branch resolves `en`/LTR, a Qatar branch resolves `ar`/RTL through
  the SAME endpoint, and the same UTC instant renders differently per
  branch timezone while `nowUtc` itself stays a stable ISO-8601 UTC
  string) plus `apps/portal`/`apps/admin` both building and linting
  cleanly with the new provider wired into their root layouts.
