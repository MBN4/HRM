# Employee/Manager self-service UI (ESS/MSS)

[← Back to CLAUDE.md](../../CLAUDE.md) · [Build log](../BUILD_LOG.md)

Defined in step 1.4 (Phase 1) — `apps/portal` (Next.js 14 App Router, tenant
org portal) and `apps/mobile` (React Native/Expo). This step is
deliberately a CONSUMPTION layer: it surfaces 0.4 (auth/RBAC), 0.5 (country
packs), 0.7 (workflow), 0.8 (notifications), 1.1 (employee), 1.2 (leave),
and 1.3 (attendance) through real UI, adding exactly two small, additive
backend endpoints along the way (`GET /employees/me` and
`POST /auth/push-token` — see below) rather than any new business logic.
Nothing about RLS, auth core, the country-pack resolution algorithm, or any
workflow/leave/attendance module's own logic changed for this step.

## Two genuinely missing backend reads, added — not a business-logic change

- **`GET /employees/me`** (`apps/api/src/employees/employees.controller.ts`,
  `EmployeeService.findOwn`). Before this step, there was no way for an
  authenticated caller to discover WHICH `Employee` row is their own —
  `GET /employees` has no `userId` filter, and every other route needs an
  `employeeId` up front. `findOwn` resolves `Employee.findFirst({ where:
{ userId } })` then delegates to the existing `findById` with
  `allowedBranchIds: null` — deliberately bypassing branch-scoping, since a
  branch-restricted caller must always be able to see their OWN record
  regardless of which branch it's in (the same "your own data is never out
  of scope" posture `LeaveService`/`AttendanceClockService` already take
  for self-service requests with an omitted `employeeId`). Field-level
  gating (`compensation` omitted without `salary.view`) still applies —
  `PermissionSerializerInterceptor` is on this route exactly like every
  other route returning an `EmployeeResponseDto`. This is what both the
  portal's `useSession()` (see below) and the mobile app's profile screen
  use to bootstrap "who am I, as an employee" once, per session.
- **`POST /auth/push-token`** (`apps/api/src/auth/auth.controller.ts`).
  `User.pushToken` (nullable `String?`, migration
  `20260828123959_add_user_push_token`) is a new column, added the SAME
  way `User.preferredLanguage` (0.8) was: a small, nullable, per-user seam
  column. This route sets/clears it (`{ pushToken: string | null }`,
  `null` deregisters). `NotificationDeliveryService.renderAndSend` now
  selects `pushToken` alongside `email`/`id` and uses it as the `to`
  address for the `PUSH` channel when present, falling back to the same
  placeholder (`recipient.id`) it always used otherwise —
  `LogPushProvider` is UNCHANGED in behavior (still only logs), so this is
  purely wiring the REGISTRATION half of push through the real pipeline;
  actual delivery still needs a real FCM/Expo-push-API-backed
  `NotificationProvider` swapped into the existing `PUSH_PROVIDER` DI
  token later — the same "swap one binding" seam 0.4's `AUTH_PROVIDER` and
  0.8's other channel providers already establish. Covered by
  `apps/api/test/auth-rbac.e2e-spec.ts`'s "push token" describe block.

Everything else this step touches is genuinely new frontend code with zero
other backend changes.

## Portal (`apps/portal`) — architecture

### Auth + tenant context on the client

- **Two-token model, held client-side, mirroring 0.4 exactly.** The access
  token lives ONLY in a module-level in-memory variable
  (`lib/auth/token-storage.ts`) — never persisted — since it's short-lived
  (15m default) and a reload should re-derive it, not trust a stale copy.
  The refresh token is persisted in `localStorage` (a browser tab has no
  stronger secure-storage primitive than that; the mobile app, which DOES
  have one, uses `expo-secure-store` instead — see below). On app load,
  `AuthProvider` (`lib/auth/AuthContext.tsx`) calls `bootstrapSession()`
  (`lib/api/auth.ts`) — if a refresh token exists, exchange it for a fresh
  access token via `POST /auth/refresh` before rendering anything gated.
  This is also the concrete mechanism the "token refresh works" test
  proves: a hard page reload wipes the in-memory access token by
  construction, so the dashboard rendering again after a reload is only
  possible via a REAL refresh round-trip, not a cache artifact.
- **`lib/api/client.ts`'s `apiFetch`** is the one place every request goes
  through: attaches `Authorization: Bearer <token>` (skippable via
  `skipAuth` for login/refresh/password-reset, mirroring `@AllowAnonymous()`
  server-side), serializes a plain object body as JSON OR passes a
  `FormData` body through untouched (for the one multipart route shape —
  clock-in/out's optional selfie, the same "binary content doesn't fit a
  JSON string" posture 1.1's document upload established server-side), and
  on a `401` triggers exactly ONE shared in-flight refresh (deduped via a
  module-level promise) before retrying the original request once — a page
  that fires several requests on mount only ever rotates the refresh token
  once, not once per request, which matters because 0.4's refresh
  rotation treats a SECOND presentation of an already-rotated token as
  theft and revokes the whole session family.
- **Tenant resolution — subdomain in production, header in local dev,
  same mechanism 0.3 already documents for "a client with no per-tenant
  hostname of its own".** `lib/tenant.ts`'s `resolveTenant()`: if the
  portal's own hostname is `<slug>.<NEXT_PUBLIC_TENANT_BASE_DOMAIN>`, it
  mirrors that exact subdomain onto the API request's target origin
  (`http://<slug>.<domain>:<NEXT_PUBLIC_API_PORT>`) — the API's own
  subdomain strategy then resolves the identical tenant from the `Host`
  header it receives, no extra header needed. On a bare `localhost` (no
  configured base domain, or the host doesn't match it — the normal local
  dev shape, and what this step's whole Playwright suite runs against),
  it falls back to sending `x-tenant-id` (`@hrm/shared`'s `TENANT_HEADER`
  constant) with a tenant slug captured once at login
  (`setStoredTenantSlug`) — genuinely the SAME strategy 0.3 built for
  mobile/API clients, not a portal-specific shortcut. The login screen
  only shows the "Workspace" field when `isUsingSubdomainResolution()` is
  false, so a real subdomain-served tenant never even sees it.

### The i18n/RTL client pattern — the first REAL use of the authoritative signal

- `apps/portal/src/i18n/I18nProvider.tsx` itself is **untouched** — its own
  doc comment already anticipated exactly this: "a future session-aware
  integration should prefer the resolved effective Country Pack's own
  `locale.rtl`... and pass it down as an explicit `rtl` override". This
  step is that future integration, achieved with ZERO changes to the
  provider: `lib/session/SessionProvider.tsx` resolves the caller's own
  Employee (`GET /employees/me`) then that employee's branch's
  EFFECTIVE Country Pack (`GET /country-packs/effective?branchId=...`),
  and `app/(app)/layout.tsx` mounts a SECOND, NESTED `<I18nProvider
locale={resolved} rtl={resolved}>` inside the root layout's default one
  — inner React context wins, so every authenticated screen renders in
  the real resolved locale/direction while the (unauthenticated) `/login`
  screen keeps the root layout's safe en/ltr default (there is no Country
  Pack to resolve before a tenant/employee is even known).
- **Gotcha this step had to work around**: `I18nProvider`'s `locale`/`rtl`
  props are read only on its OWN initial mount (`useState(initialLocale)`)
  — they are not reactive to later prop changes. Since the Employee +
  Country Pack fetch is asynchronous, mounting `<I18nProvider>`
  immediately would freeze it at the default (en/ltr) forever. The fix is
  in `(app)/layout.tsx`: `SessionProvider` exposes a `ready` boolean (true
  once BOTH the employee fetch and, if an employee exists, the pack fetch
  have settled) and `ResolvedI18n` renders a spinner until `ready`, THEN
  mounts `<I18nProvider>` — so its one real mount already has the final
  values. This is a general lesson for any future provider built the same
  "props seed initial state" way: gate the mount, don't try to push
  updates through props afterward.
- **String externalization**: every new UI string added this step lives in
  `@hrm/shared/src/i18n/messages.ts`'s `UI_MESSAGES` catalog, in BOTH `en`
  and `ar`, keyed by screen (`leave.*`, `attendance.*`, `approvals.*`,
  `profile.*`, ...) — the SAME catalog 0.9 built, just heavily grown (from
  9 keys to the full ESS/MSS vocabulary). No new mechanism, no hardcoded
  copy anywhere in `apps/portal/src`.
- **RTL layout correctness, without a Tailwind RTL plugin.** Every
  component uses Tailwind's built-in LOGICAL utilities — `ms-*`/`me-*`
  (margin-start/end), `ps-*`/`pe-*` (padding-start/end), `start-*`/`end-*`
  (positioning), `text-start`/`text-end`, `border-s`/`border-e` — instead
  of physical `ml-*`/`mr-*`/`left-*`/`right-*`/`text-left`/`text-right`.
  These already flip correctly under `dir="rtl"` (set on `<html>` by
  `I18nProvider`'s existing `useEffect`) with no extra plugin or
  per-component RTL variant needed. `apps/portal/src/app/globals.css` also
  swaps the Arabic-appropriate font (`Noto Kufi Arabic`, loaded via
  `next/font/google` alongside `Inter`) via a `[dir='rtl'] body` rule.
- **Locale-correct dates/numbers/currency**: `lib/format.ts` wraps native
  `Intl.DateTimeFormat`/`Intl.NumberFormat` with the resolved locale
  (`'en'`/`'ar'`) and the pack's `currencyCode` — never a hardcoded
  `'en-US'`. Timestamps render in the VIEWER'S OWN BROWSER TIMEZONE
  (`Intl` reads it automatically when no explicit `timeZone` option is
  passed) rather than re-fetching the employee's branch timezone for
  display — a deliberate, documented simplification: the person viewing
  their own attendance/leave data is typically physically in that same
  timezone, and 1.3's server-side timezone-correct `workDate` attribution
  is authoritative regardless of how a client happens to render it
  locally. A future admin/HR cross-timezone view would need to fetch and
  use the actual branch timezone instead — not needed for this step's ESS
  scope.

### RBAC in the UI — the same two-layer shape, applied to rendering

- `GET /auth/me`'s `permissions: string[]` is the ONLY source of truth
  `AuthContext.can(permission)` reads — no screen hardcodes a role-name
  check. The `EMPLOYEE` system role holds `employee.read` but NOT
  `employee.write` — meaning a plain employee's own `/profile` page is
  READ-ONLY by construction (the "Edit profile" button only renders for
  `can('employee.write')`, which today only `MANAGER`/`HR_MANAGER`/
  `TENANT_ADMIN` hold). This is a faithful reflection of this step's
  brief ("respect field-level permissions... don't render actions the
  user lacks permission for"), not a bug: this codebase does not yet
  distinguish "edit your OWN basic contact fields" from "hold
  `employee.write` at all" — a documented, accepted gap consistent with
  this project's "documented, not silently accepted" posture elsewhere
  (see e.g. leave.md's leaver-pro-ration gap). Extending RBAC with a
  narrower self-edit permission is a real future improvement, not
  required by this step.
- The "Team" nav section (`/approvals`, `/team`, `/org-chart`) is
  rendered unconditionally for `/approvals`/`/org-chart` (both correctly
  return an empty/self-scoped result for a caller with no standing —
  `GET /workflow/my-pending-approvals` and the org chart's branch-scoping
  already guarantee this server-side) but `/team` (the attendance/leave
  reports) is hidden from the sidebar entirely unless
  `can('attendance.approve') || can('leave.approve')`, AND the page
  itself shows a plain info notice (not a crash, not a raw 403) if reached
  directly by a caller with neither — the same "RBAC gates the feature,
  the service layer gates the row, and the UI should degrade gracefully
  rather than assume it will never be asked" posture threaded through
  every screen.
- **Field omission** (`compensation` on `EmployeeResponseDto`) is handled
  with `'compensation' in employee` — checking KEY PRESENCE, never
  truthiness — since `PermissionSerializerInterceptor` OMITS the key
  entirely rather than nulling it; `employee.compensation` being
  `undefined` is ambiguous between "omitted" and "present but literally
  undefined" in a naive truthy check, but only the `in` check correctly
  distinguishes "I'm not allowed to see this" (show
  `profile.noSalaryAccess`) from "no compensation is on file at all"
  (show `common.noData`) for a caller who DOES have `salary.view`.

### How the UI consumes the workflow/leave/attendance engines — THE RULE, from the client side too

- **Leave and attendance regularization approvals are NEVER acted on
  through a leave- or attendance-specific route** — `/approvals`
  (`lib/api/workflow.ts`, `lib/api/pending-approvals.ts`) calls the
  SAME five generic routes any workflow-driven module uses:
  `GET /workflow/my-pending-approvals`, `GET /workflow/instances/:id`,
  `POST /workflow/instances/:id/steps/:stepId/actions`. There is no
  `POST /leave/requests/:id/approve` anywhere in this codebase, by
  design (see workflow.md → THE RULE) — the portal's approvals inbox is
  proof the UI layer holds itself to the same rule the backend does.
- **`GET /workflow/my-pending-approvals` returns bare
  `WorkflowInstanceStep` rows with no `entityType`/`dataSnapshot`/
  requester context** (workflow.md's own documented "known scaling
  tradeoff" — eligibility is filtered in application code, not SQL).
  `lib/api/pending-approvals.ts`'s `loadPendingApprovals()` stitches this
  together CLIENT-SIDE: fetch each unique `instanceId`'s full detail
  (`GET /workflow/instances/:id`) for `entityType`/`dataSnapshot`, then
  best-effort resolve a human-readable employee name by matching
  `dataSnapshot.employeeId` against one bounded page
  (`GET /employees?pageSize=100`) of the tenant's employees — a
  documented, accepted simplification for a typical approvals-inbox
  volume (not a full-tenant scan on every poll), consistent with the
  backend's own documented tradeoff at the route it's built on.
- **Applying for leave / clocking in / requesting a regularization** call
  exactly the routes 1.2/1.3 already built
  (`POST /leave/requests`, `POST /attendance/clock-in`/`clock-out`,
  `POST /attendance/regularizations`) with no new request shape — the
  portal adds zero fields, zero client-side business rules (e.g. it never
  computes business-day counts, overtime, or weekend/holiday status
  itself — it only ever displays what the API already computed).

### Clock-in/out, geo, and selfie — client side

- `components/attendance/ClockWidget.tsx` requests the browser's
  geolocation (`navigator.geolocation`, via `lib/geolocation.ts`'s
  `getCurrentCoordinates` — resolves to `null` rather than rejecting on
  denial/unavailability/timeout, since geofencing is opt-in per branch and
  the API — not the client — is the source of truth on whether
  coordinates are actually required) and sends whatever it got as
  `lat`/`long` alongside `source: 'WEB'`. A configured-but-uncoordinated
  clock-in surfaces the API's real `400` message directly (e.g. "This
  branch requires your location...") rather than the client guessing
  geofence state ahead of time.
- The photo/selfie field is a plain `<input type="file" accept="image/*"
capture="user">` — multipart, matching 1.1's document-upload precedent
  exactly (the one route shape in this whole app that isn't JSON).
- **"Am I currently clocked in?"** is derived by fetching
  `GET /attendance/records?from=<yesterday>&to=<tomorrow>` and finding a
  `status: 'OPEN'` row — a 2-day window rather than "just today", because
  an overnight/midnight-crossing shift's `workDate` (frozen at clock-in,
  per attendance.md) can legitimately be yesterday's date while the
  record is still open right now.

### Testing the portal

- **Real browser, real HTTP, real Postgres/Redis/MinIO — the same "no
  mocks" posture every `*.e2e-spec.ts` in `apps/api` already holds itself
  to, extended to the UI layer for the first time.** `apps/portal/tests/`
  is a Playwright suite (`playwright.config.ts`), NOT Jest/RTL component
  tests — component-level mocking would prove the React code calls the
  right function, not that clocking in from a real browser produces a
  real `AttendanceRecord` row, which is what this step's brief actually
  asks to be proven.
- **Fixtures**: `tests/global-setup.ts` seeds two real tenants, real
  US/QA branches, real roles (`seedSystemRolesAndPermissions`, the exact
  same helper every `apps/api` e2e suite uses), real Country Packs
  (`seedCountryPacks`), a real MANAGER-rule `WorkflowTemplate` for both
  `LeaveRequest` and `AttendanceRegularization`, and real
  argon2-hashed passwords (`@node-rs/argon2`, the SAME hashing
  `PasswordService` uses server-side) — so `/auth/login` is exercised for
  real, not bypassed with a directly-signed JWT the way `apps/api`'s
  OWN faster e2e suite does for speed. `@hrm/db` (its `prisma` client,
  `seedCountryPacks`, `seedSystemRolesAndPermissions`, `SYSTEM_ROLES`) is
  a devDependency of `apps/portal` for exactly this fixture-setup
  purpose, mirroring how `apps/api`'s test files already use it.
- **Runs against the header-based tenant strategy** (no
  `NEXT_PUBLIC_TENANT_BASE_DOMAIN` configured for the test run) —
  deliberately, so the suite needs no wildcard-DNS/`/etc/hosts` setup to
  run anywhere; this is exactly the same fallback path a real mobile
  client uses, so it's genuine coverage, not a lesser substitute for the
  subdomain path.
- **A real leave-balance gotcha the tests had to work around, worth
  recording**: the US reference Country Pack's `leaveDefaults` has
  `paternityDays: 0` and `maternityDays: 0` (only Qatar's pack has
  nonzero values for either), and `ANNUAL`/`SICK` both start a fresh
  employee at `accruedDays: 0` until a scheduled accrual run — so a
  freshly-seeded US employee has ZERO available leave of every type. The
  tests grant a real balance first via the actual HR "manual grant"
  endpoint (`POST /leave/balances/:employeeId/adjust`, as the fixture
  manager, who holds `leave.approve`) rather than writing a
  `LeaveBalance` row directly — exercising the real feature that
  endpoint exists for, not a fixture shortcut.
- **`WorkflowInstance.status` is `PENDING` only until the first step
  actually activates, then `IN_STEP`** (see the `WorkflowInstanceStatus`
  enum) — a test asserting "the instance is still open" should check
  `['PENDING', 'IN_STEP']`, not hardcode `'PENDING'`; this tripped up an
  early draft of the leave-submission test.
- 14 Playwright tests across `auth.spec.ts` (login via the header
  strategy, wrong-password generic error, session survives a reload via
  real token refresh, sign-out), `ess.spec.ts` (leave submission creates
  a real `WorkflowInstance`; clock-in creates a real `OPEN`
  `AttendanceRecord` tagged `WEB`), `mss.spec.ts` (approving from the
  inbox drives the real workflow to `APPROVED` AND the real
  `LeaveBalance.usedDays` deduction, polled since the deduction is
  applied asynchronously by 1.2's workflow-event listener — same posture
  `leave.e2e-spec.ts` already takes), `rbac.spec.ts` (a plain employee
  sees no "Team" nav entry and gets a graceful notice, not a crash, at
  `/team`), `rtl.spec.ts` (a QA-branch employee renders `dir="rtl"
lang="ar"`, a US-branch employee `dir="ltr" lang="en"`, from the
  identical component tree), and `tenant-isolation.spec.ts` (switching
  the login "Workspace" slug switches tenants with zero data leakage;
  a real branch-restricted `UserBranch` row hides a QA-branch report from
  a US-restricted manager's org chart).

## Mobile (`apps/mobile`) — React Native (Expo), ESS + clock-in + push only

A from-scratch Expo/TypeScript app (`@hrm/mobile`; `pnpm-workspace.yaml`'s
`apps/*` glob picked it up with no config change). Scope is deliberately
narrower than the portal's — **ESS only, no MSS**: profile, leave, the
full attendance/clock-in flow, notifications, and the announcements seam,
plus push-token registration. No approvals inbox, no team views, no org
chart — per this step's own scope line.

### Structure mirrors the portal's, adapted for React Native

`src/{lib/{api,auth,session},i18n,theme,navigation,components,screens}` —
the same layering as `apps/portal/src/lib`, with RN-native primitives
swapping in wherever the platform differs:

- **Auth/tenant**: `src/lib/tenant.ts` — mobile has no hostname of its own
  at all, so unlike the portal (subdomain-first, header-fallback) it
  ALWAYS uses tenant-resolution strategy #3, sending `x-tenant-id` on
  every request with a slug captured once at login. The refresh token is
  stored in `expo-secure-store` (on-device encrypted storage — stronger
  than the portal's `localStorage`, since a native app has that
  primitive); the access token stays in-memory only, exactly like the
  portal, refreshed via the same single-in-flight-dedup `apiFetch`
  pattern (`src/lib/api/client.ts`, unit-tested directly since it's pure
  logic with no renderer dependency).
- **`@hrm/shared`-equivalent pieces are duplicated, not imported** —
  `src/i18n/messages.ts`/`rtl.ts`/`interpolate.ts`,
  `src/constants/{app,permissions}.ts` — same precedent
  `apps/portal`/`apps/admin`'s byte-identical `I18nProvider.tsx`
  duplication already establishes (see
  [i18n-timezone-rtl.md](./i18n-timezone-rtl.md)), chosen here because
  Metro's pnpm-workspace resolution of a hoisted TS source package added
  real friction for genuinely small, stable content. If a THIRD consumer
  ever needs this catalog, promoting all three to one shared package
  becomes worth it — not before.
- **RTL is fundamentally not a live flip on this platform.** The web
  portal's `dir="rtl"` re-renders instantly; React Native's
  `I18nManager.isRTL` is a NATIVE property baked into the current
  launch's view tree — `I18nManager.forceRTL()` only takes effect from
  the NEXT launch. `src/i18n/useRtlSync.ts` resolves the same
  authoritative signal the portal uses (the caller's own Employee's
  branch's effective Country Pack `locale.rtl`, via `GET
/country-packs/effective`, falling back to `isRtlLanguage()` only with
  no linked Employee at all) and, if it disagrees with the current native
  flag, sets it and calls `Updates.reloadAsync()` once — a documented,
  accepted platform difference from the web behavior, not a bug to
  engineer around further.
- **Attendance clock-in/out** (`src/components/attendance/ClockWidget.tsx`)
  mirrors the portal's widget shape exactly (open-record detection over a
  2-day window, optional geo, optional selfie, real API error surfaced
  as-is) with RN-native capture: `expo-location` for coordinates
  (`src/lib/geolocation.ts`, resolves to `null` rather than throwing on
  denial — the API decides if that branch actually required them),
  `expo-image-picker`'s front camera for the selfie
  (`src/lib/pickSelfie.ts`), and — the entire reason the enum value
  exists — `source: 'MOBILE'` instead of the portal's `'WEB'` (see
  [attendance.md](./attendance.md)).
- **Push notifications** (`src/lib/push.ts`): `expo-notifications` +
  `expo-device` (skips registration entirely on a simulator — no real
  push capability there) obtain an Expo push token, registered against
  the real `POST /auth/push-token` endpoint on login and again on OS-
  reported token rotation (`Notifications.addPushTokenListener`);
  `null` is sent on logout to deregister. Every step is best-effort — a
  failure here never blocks login/logout. As documented above and in the
  file's own doc comment: this wires REGISTRATION for real: delivery
  itself still goes through the backend's `LogPushProvider` (dev/log
  only) until a real FCM/Expo-push-API-calling provider is swapped in —
  a separate future step, not attempted here.
- **Design**: `src/theme/tokens.ts` mirrors the portal's Tailwind palette
  values verbatim (brand teal, sand neutrals, ink text scale, amber/coral
  accents) as plain RN `StyleSheet`-friendly constants — no NativeWind or
  other RN-Tailwind bridge, to keep the Metro/pnpm setup as simple as
  possible; every screen/component reads from this one token module so
  the app reads as visually consistent with the web portal.

### Verification — what a headless sandbox can and cannot prove

No iOS/Android simulator or EAS tooling is available in this environment,
so nothing here claims on-device/visual verification. What IS verified,
and re-confirmed independently after the initial build:
`npx tsc --noEmit` (zero errors), `npx eslint .` (zero errors/warnings —
three React-Compiler-oriented rules newly shipped in this SDK's
`eslint-config-expo` are disabled with a documented reason, since they
flag patterns byte-mirrored from the portal's own already-shipped code),
`npx expo-doctor` (21/21 checks), `npx jest` (19/19 — pure-logic tests for
the i18n catalog/RTL helpers and the API client's URL-building/header-
injection/401-refresh-retry logic, no renderer/simulator dependency), and
`npx expo export --platform android --platform ios` (a real Metro bundle
for both platforms, the closest thing to a build smoke test available
headless — `apps/mobile/package.json`'s `build` script is intentionally
scoped to these two platforms, not the default `ios,android,web`, since
this app was never asked to run in a browser and pulling in
`react-native-web` for a platform nobody requested isn't worth the
dependency; this exact gap was caught by running the real `pnpm build`
from the repo root via Turborepo, not just the scripts in isolation).
`pnpm build`/`pnpm lint` from the repo root now include `@hrm/mobile`
alongside the other six workspaces with zero `turbo.json` changes needed
(its `build`/`lint`/`test` npm scripts already match turbo's existing task
names, and Expo's own `dist/` output already matched `turbo.json`'s
existing `build.outputs` glob).
