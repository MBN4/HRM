# Table partitioning + archival

[← Back to CLAUDE.md](../../CLAUDE.md) · [Build log](../BUILD_LOG.md)

Defined in step 5.2 (Phase 5) — `packages/db`, `apps/api/src/partitioning`,
`apps/api/src/platform/partitioning`. Turns ON the native Postgres
partitioning that `attendance_records` (1.3), `audit_log` (0.9), and
`platform_audit_log` (4.1) were all deliberately built PARTITION-READY for
— composite `(id, <partition column>)` primary keys, chosen back at each of
those steps for exactly this migration. Builds on
[tenancy-rls.md](./tenancy-rls.md) (RLS + the two-DB-role design),
[audit-custom-fields.md](./audit-custom-fields.md) (`audit_log`'s DB-level
immutability), [attendance.md](./attendance.md) (`AttendanceRecord`'s
partition-ready shape), [vendor-console.md](./vendor-console.md) (the
`@PlatformRoute()` seam, `PlatformAuditLog`, dual audit), and
[scaling-data-layer.md](./scaling-data-layer.md) (this is the SAME "prove
it directly against real Postgres, not just argue it" discipline that
step's own PgBouncer/replica proofs already established).

## What's partitioned, and what isn't

| Table                | Partition key             | Grain   |
| -------------------- | ------------------------- | ------- |
| `attendance_records` | `work_date` (DATE)        | monthly |
| `audit_log`          | `occurred_at` (TIMESTAMP) | monthly |
| `platform_audit_log` | `occurred_at` (TIMESTAMP) | monthly |

All three were built with a COMPOSITE primary key from day one
(`(id, work_date)` / `(id, occurred_at)`) specifically because Postgres
requires the partition key to be part of every unique constraint/PK on a
partitioned table — the actual `PARTITION BY RANGE` conversion (this step's
`partition_high_growth_tables` migration) is therefore additive, not a
breaking schema change: same columns, same PK, same indexes, same FKs, same
RLS policy, same grants, just a different physical storage layout
underneath. **Nothing about how callers query/write these tables changes**
— Prisma (and every service in `apps/api`) still addresses them by their
one, unchanged table name; it has no idea partitions exist underneath.

**`signature_events` was assessed and deliberately NOT partitioned.** Two
independent reasons, either alone sufficient: (1) it was never built with a
composite, partition-key-inclusive primary key — it's a plain `@id` on `id`
alone — so converting it would be a real PK-shape change, not the additive
migration this step is scoped to; (2) its growth is structurally bounded
very differently from the other three — one row per lifecycle moment of a
signature REQUEST (a handful of events per document signed), not one row
per employee per day (`AttendanceRecord`) or per mutating action
system-wide (`AuditLog`/`PlatformAuditLog`). This is a scale decision, not
a safety one — its DB-level immutability and RLS are completely unaffected
either way. See the model's own doc comment in `schema.prisma`.

## The migration mechanism — additive, not a rebuild

Prisma has no partitioning DSL (the same reason RLS itself is hand-written
SQL), so the entire conversion lives in one hand-written migration,
`partition_high_growth_tables`. Per table, the recipe is:

1. `ALTER TABLE x RENAME TO x_legacy` — plus renaming its PK/FK constraints
   and indexes out of the way (`ALTER TABLE ... RENAME CONSTRAINT`/
   `ALTER INDEX ... RENAME TO`) — **a real gotcha, verified empirically
   before committing to this design**: Postgres does NOT auto-rename a
   table's indexes/constraints when the table itself is renamed, so the new
   partitioned table (created in the next step, with the SAME canonical
   constraint/index names) would collide with the still-existing old ones
   if they weren't moved aside first.
2. `CREATE TABLE x (...) PARTITION BY RANGE (<column>)` — identical
   columns/PK/FKs/indexes to the pre-partitioning table.
3. Bootstrap partitions covering (a) every existing row's actual date range
   and (b) a GENEROUS fixed window — at least the whole current calendar
   year through Q1 of the next one — via the reusable
   `hrm_ensure_range_partitions` Postgres function (see below), so a
   completely empty/fresh DB still gets a sane window, and a DB with real
   historical data gets that data's own full range covered before the copy
   in the next step ever runs.

   **A real bug this step's own test run caught before it shipped**: the
   FIRST version of this bootstrap window was narrower — just "current
   month - 1 .. current month + 3" — and running this codebase's own
   EXISTING, unmodified `attendance.e2e-spec.ts` against it immediately
   failed with `no partition of relation "attendance_records" found for
row`, because that file writes several hardcoded 2026 dates
   (`2026-03-02`, `2026-04-01`, `2026-05-01`) that fell outside the narrow
   "around today" window this migration happened to bootstrap. This is a
   concrete, real-world illustration of EXACTLY the failure mode this
   step's automated ahead-of-time partition-creation job exists to
   prevent — the fix was widening the bootstrap window to the generous
   fixed range described above (verified by resetting the local dev DB
   from scratch and re-running the full suite clean), not touching the
   existing test's own fixture dates, which is the correct direction of
   fix: this step must adapt to pre-existing data/fixtures, never the
   other way around.

4. `INSERT INTO x SELECT * FROM x_legacy` — every existing row copied,
   verbatim, into the correct partition.
5. `DROP TABLE x_legacy`.
6. Re-declare RLS (`ENABLE`/`FORCE ROW LEVEL SECURITY` + the
   `tenant_isolation` policy) and grants on the new table — identical to
   what the pre-partitioning table had.

**Proven, not just argued.** `packages/db/test/partitioning.spec.ts`
replays this EXACT recipe against a disposable scratch table seeded with
rows in three different months and asserts all three rows survive with
their exact values, landing in the CORRECT month's own partition (not just
"somewhere"). Separately, this migration was actually run against this
environment's own `audit_log` (50 pre-existing rows) and
`platform_audit_log` (1,616 pre-existing rows) during development — both
counts were confirmed unchanged after the migration.

## Automated partition management — no manual partition creation, ever

`hrm_ensure_range_partitions(parent_table, partition_prefix, from_month,
to_month)` — a `plpgsql` function created by the migration — creates every
MONTHLY partition in the given range that doesn't already exist
(idempotent: checks `pg_class`/`pg_namespace` first, so calling it
redundantly is always a no-op for partitions that already exist). This is
the ONE place partition-creation DDL is expressed; the migration's own
bootstrap step and the runtime job below both call this same function
rather than each re-implementing "loop month-by-month and `CREATE TABLE ...
PARTITION OF`" independently. `REVOKE ALL ... FROM PUBLIC` on this function
is explicit, defense-in-depth on top of the structural fact that `hrm_app`
holds no `CREATE` privilege on the schema at all (only `USAGE` — see
[tenancy-rls.md](./tenancy-rls.md)'s two-DB-role design) — proven directly:
`packages/db/test/partitioning.spec.ts` asserts calling this function
through `appPrisma` fails with `permission denied`.

`PartitionMaintenanceService` (`apps/api/src/partitioning`) is the runtime
half — the SAME scheduled-BullMQ-orchestrator shape every prior scheduled
job in this codebase establishes (`AnalyticsRollupService`, LMS's rollup/
expiry jobs, `BillingSeatMeteringService`): `onModuleInit` idempotently
registers a daily repeatable job (`0 1 * * *` UTC) that calls
`ensureAllPartitions()` — for every managed table (`PARTITIONED_TABLES`,
the one registry all three services below iterate), it resolves that
table's own `PartitionedTableConfig.lookaheadMonths` (default 3) and
ensures partitions exist from (current month - 1) through (current month +
lookahead). Always runs through the OWNER `prisma` client, never
`appPrisma` — creating a partition is DDL, an infra operation, not a
tenant-scoped one, the same class of owner-client-only work
`AnalyticsRollupService.enqueueForEveryLiveTenant`'s own `Tenant.findMany`
already is. Also reachable manually via `POST
/platform/partitioning/ensure` (`PARTITIONING_MANAGE`) — the same
"scheduled job + manual trigger, both call the identical service method"
shape 1.3's `POST /attendance/summary/run` already establishes.

Proven end to end in `apps/api/test/partitioning.e2e-spec.ts`: raising
`ATTENDANCE_RECORDS.lookaheadMonths` and triggering `/ensure` creates a
partition 11 months out (well beyond the default 3-month window), and a
REAL write to that far-future date — through the ordinary tenant-scoped
`withTenantContext` path, exactly like a real clock-in would use —
succeeds immediately afterward.

## RLS + immutability hold identically on partitions — verified empirically, not assumed

This is the property this step's own brief most wanted proven, so it was
tested directly against Postgres BEFORE committing to the migration design
(see the exploratory queries this step ran, and
`packages/db/test/partitioning.spec.ts`'s own RLS/immutability tests):

- **A `USING`/`WITH CHECK` policy declared on the PARTITIONED PARENT applies
  transparently to every partition when queried THROUGH the parent** — a
  session reading/writing `audit_log` (the only name Prisma/`appPrisma`
  ever uses) gets exactly the same tenant-isolation enforcement regardless
  of which underlying partition its rows happen to live in. Individual
  partitions cannot carry their own, different RLS policy — Postgres
  simply doesn't allow it — so there is no separate "did the new partition
  get its policy too?" question to worry about.
- **A GRANT issued on the parent does NOT propagate to direct access
  against a partition BY NAME** — verified directly: `hrm_app` can
  `SELECT`/`INSERT`/etc. through `audit_log`, but a query against
  `audit_log_p2026_09` (the same partition, addressed directly) fails with
  `permission denied`, because Postgres privileges on partitions are NOT
  automatically inherited from the parent's own grants. This is actually a
  SECURITY WIN for free: since Prisma/every service in this codebase only
  ever addresses these tables by their one parent name, this means a
  partition is, if anything, MORE locked down by default than the parent —
  there is no code path (and no way for `hrm_app`) to bypass the parent's
  RLS/grant surface by reaching for a partition directly.
- **`audit_log`'s DB-level immutability (the `REVOKE UPDATE, DELETE FROM
hrm_app` from 0.9) needs to be issued ONCE, on the parent** — it blocks
  UPDATE/DELETE for every row regardless of which partition (i.e. which
  month) it lives in, proven directly for BOTH an OLD (already-existing)
  partition and a NEWLY CREATED FUTURE one in the same test file — the
  guarantee isn't an accident of whichever partition "today" happens to
  fall in.

## Partition pruning — proven, not assumed

`packages/db/test/partitioning.spec.ts` seeds `audit_log` rows across
several different months, then runs a real `EXPLAIN` on a one-month
time-range query and asserts the resulting plan mentions ONLY that month's
partition (`audit_log_p2026_07`, say) — no other month's partition appears
anywhere in the plan text. This is Postgres's native, built-in constraint-
exclusion/partition-pruning behavior for a `PARTITION BY RANGE` table with a
literal range predicate on the partition key — nothing this codebase had to
implement — but it only exists to prove BECAUSE the table is now genuinely
partitioned; before this step, every query (regardless of date filter) was
a plain sequential/index scan over one ever-growing table.

## Archival / retention — the mechanism, and its honest Phase 6.1 boundary

`PartitionedTableConfig` (platform-wide, no `tenant_id`, no RLS — the SAME
"platform catalog" exemption `CountryPack` already establishes) holds, per
managed table: `lookaheadMonths` (feeds the maintenance job above),
`retentionMonths`, and `archiveEnabled`. Seeded with illustrative defaults
at migration time (`ATTENDANCE_RECORDS`: 24 months; `AUDIT_LOG`/
`PLATFORM_AUDIT_LOG`: 84 months / 7 years, a common statutory-audit-trail
baseline) — the same "not a certified figure, a real admin tunes this via
`PUT /platform/partitioning/config/:tableName`" posture `BILLING_PLANS`/
`seed-country-packs.ts` already document for their own illustrative
numbers.

`PartitionArchivalService` — the SAME scheduled-BullMQ-orchestrator shape,
monthly (`0 5 1 * *` UTC), plus a manual `POST /platform/partitioning/archive`
trigger. For every table with `archiveEnabled`, it finds partitions whose
range has fully aged past that table's `retentionMonths` and aren't already
archived (tracked via `ArchivedPartition`, one row per archived partition —
`tableName`+`partitionName` unique, so a partition is never processed
twice), and for each:

1. **Exports every row FIRST** — `SELECT * FROM "<partition>"` (the
   partition name is read back from Postgres's own system catalogs via
   `PartitionStatusService`, never user input, but still re-validated
   against a strict `<prefix>YYYY_MM` regex before ever being interpolated
   into a raw SQL identifier — defense-in-depth consistent with this
   codebase's "no single layer trusted alone" posture) — serialized as
   gzip-compressed JSONL, SHA-256 checksummed, and uploaded via the SAME
   `StorageService`/MinIO seam 1.1's document uploads already established,
   at `archives/<table>/<partition>.jsonl.gz`.
2. **Only once that upload has durably succeeded** does it detach
   (`ALTER TABLE ... DETACH PARTITION`) and drop the now-standalone
   partition table, and record the `ArchivedPartition` row — all three
   (detach, drop, insert) inside ONE database transaction, so a failure
   partway through rolls the whole thing back: a partition is never left
   "detached but unrecorded," and a failed export never touches the hot
   table at all.

**Retrieval path — documented, not just implied.** `GET
/platform/partitioning/archives` lists every archived partition
(`tableName`, date range, row count, checksum); `GET
/platform/partitioning/archives/:id/download` streams the gzip object back
(the SAME `StreamableFile` pattern `payroll.controller.ts`'s bank-export/
payslip downloads already establish) — an operator can independently
verify a downloaded export's integrity against its recorded
`checksumSha256`.

**Detaching/dropping a partition never touches RLS or immutability for the
data that remains** — proven directly: after archiving an old partition,
`apps/api/test/partitioning.e2e-spec.ts` confirms a RECENT row (a different
partition, never touched) is still readable and still rejects
UPDATE/DELETE exactly as before. This follows structurally from RLS/grants
being declared ONCE on the parent (see above) — removing one partition
changes nothing about the parent's own policy/grant declarations.

### The Phase 6.1 GDPR/data-residency seam — honestly scoped

`TenantRetentionOverride` (ordinary tenant-scoped table, RLS applies) lets
a tenant-specific retention preference be set and read back today — via
`PUT`/`GET`/`DELETE /platform/partitioning/tenants/:tenantId/retention-overrides/:tableName`
(`PARTITIONING_MANAGE`, the platform acting on a tenant's behalf, the same
shape `TENANT_MIGRATION_MANAGE` already establishes; dual-audited into
BOTH the target tenant's own `audit_log` and the platform's
`PlatformAuditLog`, mirroring `PlatformTenantService.recordTenantAudit`
exactly). **This is the seam this step's brief asks for, not a completed
per-tenant purge mechanism, and that boundary is stated plainly, not
glossed over**: `PartitionArchivalService`'s actual archival-eligibility
decision reads ONLY the platform-wide default (`PartitionedTableConfig`),
never a tenant override, because a single partition physically holds every
tenant's rows for that date range — there is no "archive this partition
for tenant A but not tenant B" without a genuinely different, row-level
purge mechanism (a real per-tenant GDPR right-to-erasure or
shorter-retention request would need to `DELETE ... WHERE tenant_id = X
AND <partition column> < cutoff` against a still-attached partition,
through the OWNER role — since `hrm_app`'s immutability REVOKE only
applies to `audit_log`/`platform_audit_log`, not to the owner client — a
real, buildable follow-up, but a different mechanism from whole-partition
archival, and explicitly deferred to Phase 6.1). Setting a tenant override
today is honest, working seam plumbing — visible via the API, dual-
audited, and read back correctly — it just doesn't yet change what gets
archived.

## Platform API surface

All under `platform/partitioning`, `@PlatformRoute()`, PARTITIONING_READ
(both platform roles) vs. PARTITIONING_MANAGE (PLATFORM_OWNER only — the
same "READ is broad, MANAGE is narrow" split `BILLING_READ`/`BILLING_MANAGE`
and `BRANDING_READ`/`BRANDING_MANAGE` already establish):

- `GET /config` / `PUT /config/:tableName` — the platform-wide
  lookahead/retention/archive-enabled config, audited on write.
- `GET /status` — every managed table's current partitions (name, date
  range, Postgres's own cheap `reltuples` row-count estimate).
- `POST /ensure` — manually trigger the partition-creation job.
- `POST /archive` — manually trigger the archival sweep.
- `GET /archives` / `GET /archives/:id/download` — the archived-partition
  catalog and its retrieval path.
- `GET`/`PUT`/`DELETE /tenants/:tenantId/retention-overrides/:tableName` —
  the Phase 6.1 seam above.

## Scope discipline — what this step did NOT touch

RLS policies' actual `USING`/`WITH CHECK` expressions, `withTenantContext`'s
mechanism, every existing attendance/audit/e-signature service's own
business logic, and every existing route's HTTP contract are all completely
unmodified — this step is a physical-storage change plus new, additive
management/archival machinery, never a behavior change for any existing
caller. `apps/api/src/attendance`, `apps/api/src/audit`,
`apps/api/src/platform/audit`, and `apps/api/src/esignature` gained zero
code changes.

## Known, documented gaps for this phase

Per-tenant purge within a shared partition (the real Phase 6.1 GDPR
mechanism) is not built — see the honest scope note above. Archival
currently only supports "export to the SAME S3/MinIO bucket
`StorageService` already manages" — a genuinely CHEAPER cold-storage tier
(e.g. S3 Glacier/Infrequent Access, a separate bucket/lifecycle policy) is
a config-only follow-up on the storage side, not a code change here.
Sub-partitioning `BY LIST (tenant_id)` under the monthly `RANGE` partitions
— floated as an option in the original 0.2 planning note for a very large
single tenant — was not needed at this step's scale and is not built.

Verified directly against real Postgres by
`packages/db/test/partitioning.spec.ts` (9 tests: both tables report as
genuinely partitioned on the documented key; RLS holds identically through
the partitioned parent for both `attendance_records` and `audit_log`;
`audit_log` immutability holds across two DIFFERENT partitions, an
existing OLD month and a freshly-bootstrapped FUTURE one; a one-month query
plan touches only that month's partition; the full rename→recreate→
bootstrap→copy→drop conversion mechanism replayed on a scratch table loses
zero rows and places each row in its correct partition; `hrm_ensure_range_partitions`
is idempotent and has no `hrm_app` EXECUTE grant) plus
`apps/api/test/partitioning.e2e-spec.ts` (7 tests, real HTTP against the
full stack: PARTITIONING_READ/MANAGE RBAC; partition status/config
reads; raising a table's lookahead and triggering `/ensure` creates a
far-future partition a subsequent real write immediately lands in; a full
archival cycle — export, detach, drop, list, download, gunzip-and-compare
against the original row, a second sweep being a correct no-op — while a
non-aged row in a different partition stays completely intact and still
immutability-protected; the tenant retention-override seam set/read/removed
with dual audit). Every pre-existing attendance/audit/e-signature
spec file continues to pass completely unmodified, proving this step is
transparent to every existing caller.
