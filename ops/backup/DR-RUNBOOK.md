# HRM — Backups & Disaster Recovery Runbook

Phase 6.2 slice: backups + DR only (security hardening / WCAG accessibility
are separate slices of the same phase — see `CLAUDE.md`). This is the
operational counterpart to `ops/backup/*.sh` — what an operator actually
runs, in what order, and why the targets below are what they are.

## Scope

- `backup-postgres.sh` — full logical `pg_dump` (custom format) of the
  primary database, GPG-encrypted at rest.
- `backup-minio.sh` — full export of the `S3_BUCKET` object-storage bucket
  (documents, payslips, statutory reports, AND the already-archived
  partition exports `PartitionArchivalService` writes under
  `archives/<table>/<partition>.jsonl.gz` — see
  [`docs/conventions/partitioning-archival.md`](../../docs/conventions/partitioning-archival.md)),
  tarred and GPG-encrypted at rest.
- `restore-drill.sh` — decrypts a backup, restores it into a throwaway
  scratch database, and proves data integrity + RLS + `audit_log`
  immutability survive the round trip.

This does **not** duplicate 5.2's partition archival (aging out old
partitions to cold storage) or 5.1's streaming read replica (near-zero-RPO
failover for a _live_ primary loss) — it is the independent, always-works
safety net underneath both: a point-in-time, fully offline, encrypted copy
of everything, restorable even if the replica, PgBouncer, and every
partition archive were also lost.

## RPO / RTO targets

| Component                                       | RPO target | RTO target |
| ----------------------------------------------- | ---------- | ---------- |
| Postgres (primary DB)                           | ≤ 24 hours | ≤ 2 hours  |
| Object storage (MinIO/S3)                       | ≤ 24 hours | ≤ 1 hour   |
| Full stack DR (both + re-deploy + verification) | ≤ 24 hours | ≤ 4 hours  |

**Reasoning:**

- **RPO ≤ 24h** falls directly out of the proposed backup cadence: one full
  `pg_dump` + one full bucket export per day (see Schedule below). This is
  a logical-dump-only design — there is no WAL-archiving/point-in-time-
  recovery mechanism in this slice, so the true RPO is exactly "how old is
  the last completed backup," never better than the cadence. **5.1's
  streaming read replica already gives a near-zero-RPO answer for the
  narrower "primary process/instance dies, promote the replica" failure
  mode** — that is a _complementary_, faster-but-narrower mechanism (a
  replica does not protect against a corrupted/maliciously-modified
  primary, a bad migration, or a region-wide loss; a backup does). A
  production deployment should treat replica promotion as the FIRST
  response to an instance failure and this backup/restore path as the
  fallback for scenarios the replica can't cover.
- **RTO ≤ 2h for Postgres** is extrapolated, not measured at production
  scale: the actual local dataset (13 tenants, 639 users, 628 employees,
  247 audit_log rows, ~1.06 MB raw dump) restored completely — decrypt +
  `pg_restore` + all verification queries — in under a minute end to end
  (measured: 48–68s across two real runs, see below). `pg_restore` in
  custom format is roughly linear in data + index-rebuild time; 2 hours is
  a deliberately generous target that would cover a multi-GB production
  database on modest hardware, not a number this sandbox's toy dataset can
  itself prove. **This must be re-measured against a realistic
  production-sized dump before being trusted as a real SLA.**
- **RTO ≤ 1h for object storage** follows the same reasoning: the real
  local bucket (1,289 objects, ~6.1 MB) exported completely in 15.9s.
  Production buckets holding years of documents/payslips/statutory reports
  will be larger, but object-storage restore parallelizes trivially (many
  independent PUTs), unlike a single-threaded logical DB restore.
- **RTO ≤ 4h for full-stack DR** adds the operational steps around the two
  restores themselves (recreate infrastructure, point the app at the
  restored DB/bucket, run `prisma migrate deploy` if the backup predates a
  since-shipped migration, redeploy `apps/api`/`apps/portal`/`apps/admin`,
  smoke-test) — this is a target, not something exercised end-to-end in
  this environment (no live Kubernetes cluster exists here — see the
  verified-locally/verified-at-deploy split below).

## Backup schedule

Recommended cadence (production), offset from every other scheduled job's
own cron in this codebase (`PartitionMaintenanceService` at `0 1 * * *`,
`PartitionArchivalService` at `0 5 1 * *`, `RetentionEnforcementService` at
`0 6 * * *` — see
[`docs/conventions/partitioning-archival.md`](../../docs/conventions/partitioning-archival.md)
and
[`docs/conventions/privacy-residency.md`](../../docs/conventions/privacy-residency.md)):

```cron
# Postgres full dump, daily at 02:00 UTC
0 2 * * *  BACKUP_ENCRYPTION_KEY=$(...) /path/to/ops/backup/backup-postgres.sh

# Object storage full export, daily at 02:30 UTC (after the DB dump, so a
# restore drill against "last night's backups" is always internally
# consistent within ~30 minutes of skew)
30 2 * * * BACKUP_ENCRYPTION_KEY=$(...) /path/to/ops/backup/backup-minio.sh
```

**Production hook — documented, not built (out of this slice's scope).**
This repo already has the right shape for this: `deploy/k8s/base/migration-job.yaml`
is a one-shot `batch/v1` `Job` the deploy pipeline applies and waits on (see
`deploy/k8s/README.md` § Deploy pipeline). A production backup would follow
the identical pattern as a **`batch/v1` `CronJob`** instead of a `Job`,
`schedule: "0 2 * * *"`, mounting the SAME `hrm-api-secrets`/
`hrm-api-config` (for `DATABASE_URL`, `S3_*`) plus a new
`BACKUP_ENCRYPTION_KEY` secret entry, writing to a dedicated backup
bucket/prefix (never the same `S3_BUCKET` the app itself writes into — a
compromised app credential should not be able to also delete its own
backups). Note the existing `hrm/api` image would need `pg_dump`/`gpg`
available inside it (or a small dedicated backup image built for this one
purpose) — it is not verified here whether the current `apps/api/Dockerfile`
already carries `pg_dump`/`gpg` as OS packages. A real `CronJob` manifest
was deliberately **not** authored in this slice, consistent with the
brief's own scope discipline — this paragraph is the concrete
recommendation for whoever picks that up.

## Encryption key handling

`BACKUP_ENCRYPTION_KEY` (documented in `apps/api/.env.example`, same
"env var, generated like JWT/DB secrets, never hardcoded, rotated outside
source control in any non-local environment" posture as
`FIELD_ENCRYPTION_KEY`) is the GPG symmetric passphrase both backup scripts
encrypt with (`gpg --symmetric --cipher-algo AES256`) and `restore-drill.sh`
decrypts with. **This key is a single point of failure for every backup
ever taken with it** — losing it makes every artifact encrypted under it
permanently unrecoverable; leaking it makes every artifact encrypted under
it readable by whoever has it. A real deployment must:

- Store it in a real secret manager (AWS Secrets Manager / GCP Secret
  Manager / Vault — the SAME `SECRETS_PROVIDER=aws-secrets-manager`/`vault`
  seam this codebase's own `EncryptionKeyProvider` already documents as a
  `NotImplementedException` stub in `apps/api/src/encryption/` — not
  actually integrated in this environment either), never only as a plain
  CI/CronJob env var.
- Rotate it periodically, keeping OLD keys available for decrypting OLD
  backups (mirroring the `FIELD_ENCRYPTION_KEY_VERSION`/
  `FIELD_ENCRYPTION_PREVIOUS_KEYS` rotation pattern this same `.env.example`
  documents for column-level encryption) — not built here; today there is
  exactly one key, one version, documented as a known gap below.
- Never be the same key as `FIELD_ENCRYPTION_KEY` — a backup-artifact leak
  and a database-encryption-key leak should be independent failures.

## Step-by-step DR procedure

Run in order, by an operator with access to the target Postgres
cluster/object-storage account and the `BACKUP_ENCRYPTION_KEY` secret:

1. **Identify the most recent good backups** — one `hrm-postgres-*.dump.gpg`
   and one `hrm-minio-*.tar.gz.gpg` from the backup destination (a
   dedicated bucket/prefix in production; `ops/backup/artifacts/` locally).
2. **Provision (or confirm) the target Postgres 16 instance and an empty
   S3-compatible bucket** in the SAME region as the original deployment
   (see Data residency below — this is a hard constraint, not a
   recommendation).
3. **Restore Postgres**:
   ```bash
   printf '%s' "$BACKUP_ENCRYPTION_KEY" | gpg --batch --yes --passphrase-fd 0 \
     --decrypt --output restore.dump hrm-postgres-<ts>.dump.gpg
   createdb -U <owner-role> <target-db>
   pg_restore -U <owner-role> -d <target-db> --no-owner restore.dump
   ```
   (`ops/backup/restore-drill.sh` automates exactly this against a scratch
   DB, plus the verification queries in step 5 below — reuse it as a
   template, pointed at the real target instead of a throwaway DB.)
4. **Restore object storage**: decrypt the `.tar.gz.gpg` the same way,
   `tar xzf` it, then re-upload every file under `objects/` to the new
   bucket at its own recorded key (the `manifest.json` inside the archive
   lists every key + sha256 — verify each upload against it).
5. **Re-run the RLS + `audit_log` immutability proof** (§4/§5 of
   `restore-drill.sh`) against the restored database BEFORE pointing any
   application traffic at it — this is not optional: a restore that loses
   RLS/immutability silently is worse than no restore at all, given this
   codebase's own non-negotiables (see `CLAUDE.md` § 2).
6. **Run pending migrations** if the backup predates any migration shipped
   since (`prisma migrate deploy`, the OWNER role, the identical command
   `deploy/k8s/base/migration-job.yaml` already runs).
7. **Point `DATABASE_URL`/`APP_DATABASE_URL`/`S3_*` at the restored
   infrastructure** and redeploy `apps/api`/`apps/portal`/`apps/admin`.
8. **Smoke-test**: health endpoints, a real login, one tenant-scoped read.
9. **Announce the RPO actually achieved** (the backup's own timestamp vs.
   the incident time) — this is the honest recovery-point communicated to
   the business, not the target above.

## The restore drill actually run for this slice

`restore-drill.sh` was run twice against this environment's real, live
`hrm-postgres` container (13 tenants / 639 users / 628 employees / 16
branches / 247 `audit_log` rows at the time) — full real output, both runs
identical in outcome:

```
[restore-drill] using backup artifact: ops/backup/artifacts/hrm-postgres-hrm_dev-20260915T114329Z.dump.gpg

=== 1. Decrypting backup artifact ===
gpg: AES256 encrypted data
gpg: encrypted with 1 passphrase
  decrypted to /tmp/tmp.YPU6vl8Gzq/restore.dump (1089262 bytes)

=== 2. Restoring into scratch database 'hrm_dr_drill_20260915114228' ===
CREATE DATABASE
  pg_restore exit code: 0

=== 3. Data integrity: row counts (source hrm_dev vs. restored hrm_dr_drill_20260915114228) ===
  [PASS] tenants: source=13 restored=13 (match)
  [PASS] users: source=639 restored=639 (match)
  [PASS] employees: source=628 restored=628 (match)
  [PASS] branches: source=16 restored=16 (match)
  [PASS] audit_log: source=247 restored=247 (match)
  [PASS] sample tenant row (2663b181-34b9-44a6-839f-9d6d113afa84) content matches: loadtest-small-6|LoadTest Small Co 6|TRIAL

=== 4. RLS on the restored database ===
  [PASS] hrm_app query with NO tenant context set fails loudly, as required: ERROR:  unrecognized configuration parameter "app.current_tenant"
  [PASS] hrm_app with app.current_tenant='2663b181-34b9-44a6-839f-9d6d113afa84' sees exactly that tenant's 1 branch(es) — 15 branch(es) belonging to OTHER tenants stay invisible

=== 5. audit_log DB-level immutability on the restored database ===
  [PASS] hrm_app UPDATE against restored audit_log rejected: ERROR:  permission denied for table audit_log
  [PASS] hrm_app DELETE against restored audit_log rejected: ERROR:  permission denied for table audit_log

=== RESULT: ALL CHECKS PASSED ===
[restore-drill] dropping scratch database 'hrm_dr_drill_20260915114228'...

real    0m47.851s
```

Encryption itself was independently verified (not just assumed from the
`gpg` exit code): `gpg --list-packets` on the encrypted `.dump.gpg`
confirms `AES256 encrypted data`/`symkey enc packet`; decrypting with a
**wrong** passphrase fails cleanly (`gpg: decryption failed: Bad session
key`, no output file produced, exit code 2); `grep -a` for the plaintext
dump's own `PGDMP` magic-header string against the encrypted file finds
nothing.

The RLS proof specifically confirms the property that matters most for
this codebase: `hrm_app` is the SAME cluster-wide role in the restored
database (roles are cluster objects, not per-database — see
[`docs/conventions/tenancy-rls.md`](../../docs/conventions/tenancy-rls.md)),
so `pg_restore`'s own `GRANT`/RLS-policy statements (captured by `pg_dump`
as part of each table's definition) re-establish the exact same enforcement
surface with zero manual re-configuration.

## Verified-locally vs. verified-at-deploy

**Verified locally, with real command output (this environment, right
now):**

- A real `pg_dump -Fc` of the live `hrm_dev` database (13 tenants, 639
  users, 628 employees, 247 `audit_log` rows), encrypted with GPG symmetric
  AES-256, in 3.0s end to end.
- A real full export of the live MinIO bucket (1,289 objects, 6.1 MB,
  including a genuine `PartitionArchivalService`-written archive object,
  `archives/audit_log/audit_log_p2023_05.jsonl.gz`), tarred and encrypted,
  in 15.9s end to end.
- Genuine encryption at rest: `gpg --list-packets` confirms real AES-256
  ciphertext; decryption with the wrong passphrase fails cleanly; the
  plaintext dump's own magic header is absent from the encrypted file.
- A full restore drill into a real, separate scratch Postgres database
  inside the same live cluster — decrypt, `pg_restore`, row-count parity
  on 5 tables, a byte-identical sample-row check, RLS enforced identically
  (no-context query fails loudly; tenant-scoped query returns exactly that
  tenant's rows and nothing else), and `audit_log`'s `REVOKE UPDATE,
DELETE FROM hrm_app` surviving the restore (both an `UPDATE` and a
  `DELETE` attempt rejected with `permission denied`) — run twice, both
  fully green, ~48–68s each including all verification queries.
- The live `hrm_dev` database was never written to or modified — every
  restore targeted a disposable `hrm_dr_drill_<timestamp>` database, always
  dropped at the end (`restore-drill.sh`'s own `trap cleanup EXIT`, unless
  `--keep` is passed).

**Verified-at-deploy only — genuinely not exercisable in this sandbox, not
glossed over:**

- **True cross-region backup replication.** These scripts write to local
  disk (or, in production, one bucket/prefix). A genuinely resilient DR
  posture replicates encrypted backups to a SECOND region/provider — no
  second region exists in this environment (the same honest boundary
  `docs/conventions/deployment-scaling.md` § Regional deployment and
  `docs/conventions/privacy-residency.md` § Residency enforcement already
  draw for themselves). This is a **documented seam**, not something these
  scripts do today.
- **A real cloud KMS/secrets manager for `BACKUP_ENCRYPTION_KEY`.** Used a
  plain local env var for this drill (the `SECRETS_PROVIDER` seam
  documented above is a stub, same as `FIELD_ENCRYPTION_KEY`'s own).
- **Restore at production data scale.** The RTO targets above are
  extrapolated from a dataset measured in single-digit megabytes; a
  multi-GB/multi-tenant-at-20M-users production database's actual
  `pg_dump`/`pg_restore` timing has not been, and cannot honestly be,
  measured in this environment.
- **A CronJob actually running on a schedule inside a live cluster** —
  no Kubernetes cluster exists in this sandbox (the same boundary 5.3
  already drew for HPA/KEDA scale events). The recommended cron cadence
  above is a documented recommendation, not something observed firing on
  a schedule.
- **Actual failover DNS/networking/load-balancer re-pointing** during a
  real regional incident.

## Data residency

Backup artifacts must stay in the SAME region as the source data —
`Tenant.hostingRegion`/this stack's own `DEPLOYMENT_REGION` (5.3's
regional-deployment seam, enforced at the application layer since 6.1 — see
[`docs/conventions/privacy-residency.md`](../../docs/conventions/privacy-residency.md)
§ Residency enforcement). Concretely: a `me-south-1` deployment's backups
(covering, today, the Pakistan pack's own real first client — see
[`docs/conventions/pakistan-pack.md`](../../docs/conventions/pakistan-pack.md))
must be written to `me-south-1` storage, never copied to a `us-east-1`
backup bucket as a side effect of a shared/global backup pipeline. This
follows directly from 5.3's own separate-stack-per-region topology (each
region already has its own Postgres + S3 bucket — see
`deploy/k8s/overlays/<region>/`) — a per-region backup destination is the
natural, low-effort extension of that topology, not a new mechanism.

**Cross-region backup REPLICATION for a genuinely multi-region deployment
(e.g. a DR copy of `me-south-1`'s backups also held in a second region for
resilience against a whole-region outage) is a documented SEAM, not
enforced by these scripts today.** Nothing here prevents an operator from
manually copying an encrypted backup artifact across regions if a specific
DR posture calls for it — but `backup-postgres.sh`/`backup-minio.sh`
themselves write only to the local/single destination they're pointed at,
and make no region-aware routing decision of their own. Building that
routing (and reconciling it against each jurisdiction's own data-
localization rules — see `deploy/k8s/overlays/me-south-1/kustomization.yaml`'s
own PECA/State-Bank-of-Pakistan `VERIFY` note) is future work, explicitly
out of this slice's scope.

## Known gaps / deferred

- **No automated schedule wired up** — the cron/CronJob recommendation
  above is documented, not built (see § Backup schedule's own "documented,
  not built" note) — in scope discipline with the brief, which asked for a
  documented recommendation, not new `deploy/k8s/` manifests.
- **No key rotation for `BACKUP_ENCRYPTION_KEY`** — one key, one version,
  today. The `FIELD_ENCRYPTION_KEY_VERSION`/`_PREVIOUS_KEYS` pattern this
  same env file establishes for column-level encryption is the obvious
  template for a future rotation mechanism here, not yet built.
- **No automated backup-retention/pruning** — `ops/backup/artifacts/` (or
  a production backup bucket) grows unbounded unless an operator manually
  prunes old artifacts; there is no equivalent of 5.2's
  `PartitionedTableConfig.retentionMonths` for backups themselves.
- **No cross-region replication mechanism** — see § Data residency above.
- **RTO targets are extrapolated, not measured at production scale** — see
  § Verified-locally vs. verified-at-deploy above; this is the single
  biggest honesty caveat on this whole document and should be revisited
  the moment a realistic production-sized dataset is available to drill
  against.
- **`restore-drill.sh`'s row-count/sample-row proof covers 5 representative
  tables** (`tenants`, `users`, `employees`, `branches`, `audit_log`), not
  every table in the schema — chosen because they cover the tenant-root
  table, a plain tenant-scoped table, RLS's own enforcement target, and the
  DB-immutable table specifically, not because every other table is
  assumed safe without evidence; a full per-table sweep would be a
  straightforward extension of the same script.
