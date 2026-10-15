# Kiosk mode — a shared attendance terminal

[← Back to CLAUDE.md](../../CLAUDE.md) · [Build log](../BUILD_LOG.md) · builds on [attendance.md](./attendance.md),
[attendance-status.md](./attendance-status.md), [shift-scheduling.md](./shift-scheduling.md),
[integrations.md](./integrations.md) (API keys, the biometric seam), [resilience.md](./resilience.md)

Defined in step 11.1. One screen (a tablet) at a location where **many employees** clock in and out, instead of each
using their own device. It is a **consumer** of the attendance module: there is no attendance logic in this feature. A
kiosk punch is `AttendanceClockService.clockInForEmployee / clockOutForEmployee` with source `KIOSK`, so it lands in the
same `attendance_records` table and flows through shift resolution, day attribution, overtime/lateness, the 8.1
classification, the summary rollup and payroll exactly like a web/mobile punch.

## 1. The device model

A **kiosk** (`kiosks` table) is a registered shared device bound to **one tenant and one branch**, fixed at registration.

| Field                                    | Notes                                                                                                                                                                                                                                                       |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tenantId`, `branchId`                   | The device's whole authority is "this tenant, this branch". Branch cannot be changed later (re-register instead).                                                                                                                                           |
| `tokenPrefix` (unique) + `hashedToken`   | `kio_` + 32 random bytes (base64url). The first 16 chars are an indexed lookup prefix; the rest is verified against an **argon2id** hash — the same shape as 3.3's `ApiKey`. The raw token is returned **once** (register / rotate) and can't be recovered. |
| `status` `ACTIVE`/`REVOKED`, `revokedAt` | Revocation is immediate: there is no token cache.                                                                                                                                                                                                           |
| `requirePhoto`                           | Every punch must carry a photo (buddy-punching deterrent).                                                                                                                                                                                                  |
| `biometricEnabled`                       | Opt-in trust of a hardware reader (see §5).                                                                                                                                                                                                                 |
| `lastSeenAt`                             | Heartbeat, written at most once a minute. "Online" in the admin list = seen in the last 5 min.                                                                                                                                                              |

`EmployeeKioskPin` (`employee_kiosk_pins`) holds one **argon2id-hashed** PIN per employee. Both tables are tenant-RLS'd
(`tenant_isolation`, `FORCE ROW LEVEL SECURITY`) like every tenant table. `AttendanceRecord` gained
`clockInKioskId`/`clockOutKioskId` (plain UUIDs, **no FK** — the table is range-partitioned with a composite PK, the same
reasoning `AttendanceRegularization.attendanceRecordId` documents) and `AttendanceSource` gained `KIOSK`.

## 2. The device trust model — what a kiosk can and cannot do

A kiosk authenticates as **itself**, never as an employee, via a **third, parallel auth path** next to JWT and 3.3's API
key: the `X-Kiosk-Token` header, handled in `TenantScopeInterceptor` (`handleKioskRequest`). It has a **two-way fence**:

- a route marked `@KioskRoute()` (`apps/api/src/auth/kiosk/kiosk-route.decorator.ts`) accepts **only** a kiosk token — a
  user JWT or API key is a `401` there;
- **every other route** rejects a request carrying `X-Kiosk-Token` with `403` **before any tenant work happens** (no
  transaction, no RBAC consulted).

So a stolen device token reaches exactly four endpoints and nothing else, regardless of what any other route's own RBAC says.
The request context a kiosk gets is `userId: null`, `roles: []`, `permissions: []` plus a new `kiosk` field
(`{id, branchId, name, …}`); `PermissionsGuard` can therefore never be satisfied by a kiosk, by construction. The same
`withTenantContext` transaction runs underneath, so **tenant RLS is enforced identically** to every other path.

**Branch scoping is enforced in the query itself**: every employee lookup is `where: { employeeCode, branchId: kiosk.branchId,
status: 'ACTIVE' }`. An employee of another branch (or another tenant — RLS) is simply _not found_, and the response is
byte-identical to a wrong PIN, so a kiosk can't be used to probe who works where. The kiosk can't read employee data: the
only employee fields any response carries are `employeeCode`, `firstName`, `lastName` (for "Hello, Sam").

`TENANT_STATUS` (4.1) and residency (6.1) apply to kiosk requests too, and the 0.10 per-tenant rate limit runs before the
transaction opens. The token lookup uses the **owner** `prisma` client — the one narrow exception, because the token is what
_establishes_ the tenant (identical to `ApiKeyAuthService`, same doc'd reasoning).

## 3. Identify-and-clock

`apps/api/src/kiosk/` — device routes (`@KioskRoute()`, controller `kiosk-device.controller.ts`):

| Route                                                                           | Purpose                                                                                                                                                       |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /kiosk/me`                                                                 | The device's own name, branch name, **timezone** and options, so the screen can render.                                                                       |
| `POST /kiosk/identify` `{employeeCode, pin}`                                    | Verify → returns a short-lived **ticket**, the display name and **today's state** (open since, last clock-out, suggested action, the 8.1 day classification). |
| `POST /kiosk/identify/biometric` `{employeeCode}`                               | Only when the kiosk opted in (§5).                                                                                                                            |
| `POST /kiosk/clock` (multipart `ticket`, `action` `IN`/`OUT`, optional `photo`) | Redeem a ticket into a real punch.                                                                                                                            |

**The ticket** (`KioskTicketService`) is a stateless, HMAC-SHA256-signed claim bound to `{tenant, kiosk, employee, method,
expiry}` (60 s), keyed by a value **derived from `JWT_SECRET` under a distinct label** so it can never be confused with an
access token. It exists so the screen can show "Hello, Sam — Clock in / Clock out" between identify and punch without
re-sending the PIN. It is **not a credential**: it is only honoured on a call that also carries the **same kiosk's** device
token, and at redemption the employee is **re-checked** (still `ACTIVE`, still in this branch) — a person terminated or
transferred between identify and punch can't be clocked. A ticket from another device, a tampered or forged-for-another-
employee ticket, or an expired one all return the same `400 KIOSK_TICKET_INVALID`.

Errors carry stable `code`s the screen maps to localized messages: `KIOSK_INVALID_CREDENTIALS` (401), `KIOSK_LOCKED` (429,
with `retryAfterSeconds`), `KIOSK_TICKET_INVALID`, `KIOSK_ALREADY_CLOCKED_IN`, `KIOSK_NOT_CLOCKED_IN`, `KIOSK_PHOTO_REQUIRED`,
`KIOSK_PHOTO_INVALID`, `KIOSK_BIOMETRIC_DISABLED`. "Outside shift" is not an error: attendance has never blocked a punch for
being off-roster, it classifies it (a late punch comes back as `today.status: RED`/`YELLOW` with the reason).

**Photo** (`requirePhoto`): JPEG/PNG/WebP, ≤ 5 MB, stored through 1.1's `StorageService` under the existing
`attendance/<tenantId>/<employeeId>/…` key layout; the client-supplied file name is sanitized before it becomes part of a key.

## 4. PIN handling — the real security of a low-entropy secret

A 6-digit PIN is only 10⁶, so its safety does **not** come from the PIN:

1. **Identification is `employeeCode` + PIN**, not PIN alone. The code selects one employee; an attacker can't just try
   PINs against "anyone". (PIN-only would need a deterministic, searchable PIN hash — weaker.)
2. **Per-employee lockout**: 5 wrong PINs → locked 15 min (the lock follows the _employee_, across every kiosk; even the
   right PIN is refused while locked). An HR reset also unlocks.
3. **Per-kiosk caps**: ≤ 30 identify attempts/min, and ≤ 20 _failed_ attempts per 10 min per device — caps spraying across
   many employee codes from one terminal.
4. **Unknown employee ≡ wrong PIN**: identical response body, and the unknown path still spends one argon2 verify (against a
   dummy hash) so timing doesn't reveal which codes exist.
5. A compromised PIN can only ever clock **that** person in/out at **their branch's** kiosk — nothing else.

> **Gotcha worth knowing (and tested):** the identify request that records a wrong PIN ends in a `401`, which **rolls back the
> whole request transaction**. A DB counter or an in-transaction audit row would be rolled back with it and the lockout would
> never trip. So failure counters live in **Redis** and failed-identify audit rows are written via
> `AuditRecordService.recordForTenant` (its _own_ transaction), both outside the request transaction.

PINs are **admin-issued** (`POST /kiosks/pins/:employeeId` → 6 CSPRNG digits, shown once, stored as an argon2id hash;
re-issuing = reset). Employee-set PINs are a documented fast-follow. The audit redactor gained `^pin$|pinHash` so an issued
PIN can never be written to `audit_log` (it already matched `token`).

## 5. Biometric (opt-in, through the existing seam)

When `biometricEnabled`, `POST /kiosk/identify/biometric {employeeCode}` identifies an employee **without a PIN**, and the
punch goes through 1.3's `BIOMETRIC_DEVICE_ADAPTER` (`ManualBiometricDeviceAdapter` today) so the record is source
`BIOMETRIC`, then the kiosk id is stamped on it. **Trust model, stated plainly:** this lets whoever holds the device token
name an employee of that branch with no second factor — correct _only_ when a hardware reader attached to a locked-down
terminal is what produces that claim. It is therefore **off by default**, branch-fenced like everything else, and the admin
UI describes it as "only enable for hardware you control". No real hardware integration was built (a dev/manual adapter, as
specified).

## 6. Administration (`kiosk.manage`)

New permission `kiosk.manage` — TENANT_ADMIN/CEO (via `ALL_PERMISSIONS`) and HR_MANAGER; migration backfills existing
tenants. Deliberately separate from `attendance.write`. `/kiosks` (`kiosk-admin.controller.ts`, JWT only — a kiosk token is a
`403` there, so a device can't administer devices):

`GET /kiosks` · `POST /kiosks` (token shown once) · `PATCH /kiosks/:id` (name/options) · `POST /kiosks/:id/token` (rotate: old
token dies immediately; also re-activates a revoked kiosk) · `DELETE /kiosks/:id` (revoke) · `GET /kiosks/:id/activity` ·
`GET /kiosks/pins` · `POST|DELETE /kiosks/pins/:employeeId`. A branch-restricted admin only sees/acts on their branches.
Every admin action is `@AuditLog`'d; every punch is audited (`KIOSK_CLOCK_IN/OUT`, entity `AttendanceRecord`) with
`metadata: {kioskId, kioskName, branchId, employeeId, employeeCode, method, photo, ip, userAgent}` and a null actor user;
failures are `KIOSK_IDENTIFY_FAILED` / `KIOSK_PIN_LOCKED`.

Privacy (6.1): the erasure engine deletes an employee's `EmployeeKioskPin`. A terminated employee can't identify
(`status: 'ACTIVE'` is in the lookup).

## 7. The screens

**`/kiosk`** (`apps/portal/src/app/kiosk`, `components/kiosk/KioskScreen.tsx`) — deliberately **outside the `(app)` route
group**: no sidebar, no topbar, no session gate, no links. It uses its **own** API client (`lib/kiosk/device.ts`) that sends
the device token only — never an `Authorization` header, never the tenant header, never a refresh (asserted in Playwright by
inspecting every request header). Pairing: open the launch link `/kiosk#token=…` (the token rides in the URL **fragment**, so
it never reaches a server/access log, and the page strips it from the address bar immediately) or paste it on the setup
screen; it is then kept in that browser's `localStorage` — acceptable for a dedicated locked-down device, and revocable
server-side at any time. A revoked/invalid token (any `401` other than wrong-credentials) shows a "deactivated" screen. "Reset
device" (confirm dialog) unpairs it. Flow: **idle** (employee ID + on-screen keypad, `inputMode="none"` so a tablet doesn't
pop a system keyboard; a physical keyboard still works) → **confirm** (name, today's state/status chip, big Clock in / Clock
out — only the valid action is enabled, 60 s countdown, Cancel) → **done** (confirmation, hours worked on clock-out, auto-reset
after 7 s) → idle. Idle fields wipe after 45 s of inactivity. i18n en/ar with an EN/العربية switch (remembered per device),
RTL via the existing `I18nProvider` (the keypad deliberately stays LTR, like a dial pad), light/dark via the existing
`ThemeToggle`, logical spacing throughout, ≥ 56 px touch targets, axe-clean in light/dark/RTL.

**`/kiosks`** (`(app)/kiosks`, sidebar "Kiosks" under admin, `kiosk.manage`) — Devices tab (register with name/branch/options;
token modal with copy + the launch link; rotate / revoke with confirms; photo/biometric toggles; online/last-seen; per-device
recent-punch activity) and Employee PINs tab (branch + search filter; issue/reset/remove; locked badge; PIN shown once).

## 8. How to add / change things

- **A new kiosk capability** → add a handler to `kiosk-device.controller.ts` (it inherits `@KioskRoute()`), keep it
  branch-fenced in the service query, and add a case to the "refused on every non-kiosk route" / branch tests. Never put
  `@KioskRoute()` on a route that reads employee data.
- **A real biometric reader** → bind a real `BIOMETRIC_DEVICE_ADAPTER` (1.3's seam); nothing in the kiosk module changes.
- **Employee-self-set PINs** → a JWT `PUT /kiosks/pins/me` using `KioskPinService` + re-auth with the account password.

## 9. Verification

`apps/api/test/kiosk.e2e-spec.ts` (**34 tests**, real HTTP + Postgres + Redis + MinIO): token returned once / hash-only;
audit never contains the token or PIN; `kiosk.manage` RBAC on every admin route; identify → clock-in → clock-out produce a
**normal `KIOSK` record**, judged by a real published roster shift (`expectedStartTime: 00:00`, RED) and **identical to
`GET /attendance/status`** for the same day; double clock-in / clock-out-with-nothing-open codes; wrong PIN ≡ unknown employee;
lockout (right PIN refused, follows the employee across kiosks, HR reset unlocks); per-device spray cap with all 20 failures
audited despite the rolled-back transactions; a kiosk token is `403` on **14 representative non-kiosk routes** and a JWT/API
key/garbage is `401` on kiosk routes; **another branch** and **another tenant** (even with the same employee code) can't be
clocked; ticket bound to its device, tampered/forged/expired tickets refused; employee moved/terminated between identify and
punch refused; revoked → immediate `401`, rotate kills the old token; suspended tenant blocks kiosks; photo required/invalid/
sanitized key; biometric off by default, through the seam when on; cross-tenant isolation (API **and** RLS at the DB).
`apps/portal/tests/kiosk.spec.ts` (**16 Playwright tests**, real browser): pairing + fragment stripping + "only the device token
is ever sent", wrong PIN, full clock-in/out through the on-screen keypad, auto-reset, cancel, Arabic/RTL + dark + axe on the
idle/identified/done/admin screens, tablet viewport, revoked (at load and mid-use), reset device, a real fake-camera photo
punch, and the admin end-to-end (register → token once → issue PIN → that kiosk + PIN clock someone → activity → revoke).

## 10. Known gaps (honest)

- PINs are admin-issued only (no employee self-set / forced rotation).
- The device token lives in the browser's `localStorage`; anyone with devtools access to the kiosk browser can read it. Mitigate
  with a locked-down kiosk browser/MDM profile; revoke/rotate from `/kiosks`. (A native shell with secure storage is the next step.)
- Lockout and failure counters are Redis state: a Redis flush resets them (the audit trail of failures is in Postgres).
- No attendance-photo viewer yet (stored, flagged `hasPhoto` in activity; not rendered); no photo retention policy beyond 5.2's.
- The per-kiosk caps are fixed constants (`kiosk.constants.ts`), not tenant-configurable.
- The kiosk screen doesn't work offline (no queued punches) — a punch needs the server.
- `mobile` is untouched.
