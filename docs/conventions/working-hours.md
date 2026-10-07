# Working-hours policy (step 8.1, Part 1)

[← Back to CLAUDE.md](../../CLAUDE.md) · [Build log](../BUILD_LOG.md)

Defined in `packages/db` (one migration), `packages/shared`
(`working-hours.validator.ts`), `apps/api/src/working-hours`,
`apps/portal` (`/working-hours`). **Part 1 of a series: the policy, its
resolution and its admin UI — and nothing else.** Day-status classification
(green/yellow/red), the live clock, the attendance graph and leave allocation
are later parts that consume the resolver below. Builds on
[attendance.md](./attendance.md) and [country-packs.md](./country-packs.md),
reusing the 1.3 `resolveAttendancePackConfig` util (not rebuilding attendance,
auth or RLS).

## The model — `WorkingHoursPolicy`

One tenant-scoped, RLS'd table (`working_hours_policies`, the identical
`tenant_isolation` policy as every tenant table) with a `scope` discriminator:

| Scope     | Target                          | Meaning                          |
| --------- | ------------------------------- | -------------------------------- |
| `COMPANY` | the tenant (one row)            | the default for everyone         |
| `TEAM`    | a `Department` (`departmentId`) | override for a team / department |
| `MEMBER`  | an `Employee` (`employeeId`)    | override for one person          |

Fields: `startTime` ("HH:mm", branch-local expected clock-in), `workHours`,
`breakHours` (stored **separately** so "8 work + 1 break" is explicit;
**`requiredHours = workHours + breakHours`**), `graceMinutes` (default 15),
`halfDayThresholdHours` (nullable). **The timezone is never stored here** — it
is the member's **branch** timezone, returned alongside the resolved policy.

- **Uniqueness without the NULL trap**: `targetKey` (`'company'` | departmentId |
  employeeId) is a derived, never-null column and `@@unique([tenantId, scope,
targetKey])` — a plain composite unique over nullable `departmentId`/`employeeId`
  would let duplicates through (NULLs are distinct), the same trap
  `PayrollRun`/`GeneratedReport` already document.
- **Half-day default**: `halfDayThresholdHours` null ⇒ derived at resolution as
  `requiredHours / 2` (8 work + 1 break ⇒ **4.5**) and flagged
  `halfDayThresholdDerived: true`. When set it must be `> 0` and `< requiredHours`.
- Composite FKs to `Department`/`Employee` (cascade on delete) keep a policy inside its tenant at the schema level too.
- "Team" is the department; the employee's department chain is walked **up** — a
  department with no policy inherits its **nearest ancestor's** (depth-capped).

## Resolution — `WorkingHoursResolverService.resolve(tx, tenantId, employeeId, date?)`

```
member override  ??  team (nearest department with a policy)  ??  company default  ??  Country Pack
```

Returns `{ employeeId, branchId, timezone, date, policy:{startTime, workHours,
breakHours, requiredHours, graceMinutes, halfDayThresholdHours,
halfDayThresholdDerived}, source:'MEMBER'|'TEAM'|'COMPANY'|'COUNTRY_PACK',
policyId, sourceDepartmentId }`. It takes an explicit `tx` + `tenantId` (no
request-context dependency) so it works from an HTTP request **and** a worker —
the constraint `attendance-country-pack.util.ts` documents. The `WorkingHoursModule`
exports it; Parts 2+ just inject it.

**Country Pack fallback** (when no row applies): the pack's `workingTime` only has
`standardWeeklyHours` + `weekendDays`, so `workHours = standardWeeklyHours / (7 −
weekend days)` (US 40/5 = **8**, Qatar 48/5 = **9.6**), and `startTime` 09:00,
`breakHours` 1, `graceMinutes` 15 come from `WORKING_HOURS_DEFAULTS` in
`@hrm/shared`. No country code is ever branched on — the same function yields
different results from different packs (proven by test).

`date` is accepted and echoed but **does not affect the result yet** (policies are
not effective-dated); the parameter is there so Part 2+ call sites don't change
when versioning is added.

## API (`/working-hours`, tenant-scoped, RLS)

| Route                                                                  | Permission                                                                            |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `GET /policies` (scope, target, values)                                | `working_hours.manage`                                                                |
| `GET /targets` (departments + employees for the pickers)               | `working_hours.manage`                                                                |
| `PUT /company`, `PUT /teams/:departmentId`, `PUT /members/:employeeId` | `working_hours.manage` (audited `SET_COMPANY/SET_TEAM/SET_MEMBER`)                    |
| `DELETE /teams/:departmentId`, `DELETE /members/:employeeId`           | `working_hours.manage` (audited `REMOVE_*`) — the company default can only be edited  |
| `GET /effective?employeeId&date`                                       | `attendance.read`; **own** policy always, someone else's needs `working_hours.manage` |

**Permission `working_hours.manage`** — new in the catalog; `TENANT_ADMIN`/`CEO`
(all permissions) and `HR_MANAGER` explicitly, **not** `MANAGER`/`EMPLOYEE`. The
migration backfills it for existing tenants. **Guards**: zod (`HH:mm`, work > 0,
break ≥ 0, grace int ≥ 0, half-day > 0 and < required, total ≤ 24, unknown
fields rejected); a **branch-restricted** caller cannot change the company default
and can only target teams/members in their branch scope; RLS makes another
tenant's department/employee simply 404.

## Admin UI — `/working-hours` (portal)

Admin-group nav entry (only with `working_hours.manage`; the page also shows a
no-access notice). Four cards: **Company default** (inline form), **Team
overrides** and **Member overrides** (tables + add/edit/remove via a modal with a
searchable styled `Select`), and **Effective policy** — pick a member (and
optionally a date) to see the resolved values, the winning **source** (member /
team — naming the department, or "inherited" — / company / Country Pack), the
branch timezone, and a four-step precedence strip. Light/dark, en + ar, RTL.

## Demo data

`seed:demo` (acme-demo): company 09:00 / 8+1 / 15m; a **team** override for US HQ
**Engineering** (10:00 / 10m); a **member** override for **Ivy Intern**
(`intern@acme-demo.local`: 07:30 / 7+1 / 30m / 4h half-day). Sign in as
`hr@acme-demo.local` (or `ceo@`) and pick Ivy / any Engineering employee / anyone
else in the Effective card — three different sources.

## For Part 2 (day-status classification)

Inject `WorkingHoursResolverService` and call `resolve(tx, tenantId, employeeId,
date)`: `startTime` + `graceMinutes` give on-time vs late (evaluate in the
returned branch `timezone`), `requiredHours` full day, `halfDayThresholdHours`
half/short. Nothing in attendance classification was changed in this part.

## Verification

See the 8.1 entry in [BUILD_LOG.md](../BUILD_LOG.md).
