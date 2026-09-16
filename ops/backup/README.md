# HRM — Backups & disaster recovery (Phase 6.2)

See [`DR-RUNBOOK.md`](./DR-RUNBOOK.md) for RPO/RTO targets, the full DR
procedure, the verified-locally/verified-at-deploy split, and the data
residency constraint. This file is just the quick "what's here, how do I
run it" index.

## Files

- `backup-postgres.sh` — full logical `pg_dump` (custom format) of the
  primary database as the owner role, GPG-encrypted (AES-256) at rest.
- `backup-minio.sh` — full export of the `S3_BUCKET` object-storage bucket
  (documents, payslips, statutory reports, and the 5.2 partition-archival
  exports), tarred and GPG-encrypted (AES-256) at rest.
- `minio-export.js` — the `@aws-sdk/client-s3`-based Node helper
  `backup-minio.sh` shells out to (no `mc`/`aws` CLI is available in this
  environment — see that script's own header comment).
- `restore-drill.sh` — decrypts a backup, restores it into a throwaway
  scratch database (never the live `hrm_dev`), and proves data integrity +
  RLS + `audit_log` immutability all survive the round trip. Run this
  regularly — an untested backup is not a backup.
- `DR-RUNBOOK.md` — RPO/RTO targets + reasoning, the step-by-step DR
  procedure, the actual restore-drill output this step produced, data
  residency, and known gaps.
- `artifacts/` — local output directory (gitignored) for backup artifacts
  produced by these scripts. Never commit anything here.

## Quick start (local dev)

```bash
export BACKUP_ENCRYPTION_KEY="$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")"

./ops/backup/backup-postgres.sh     # -> ops/backup/artifacts/hrm-postgres-hrm_dev-<ts>.dump.gpg
./ops/backup/backup-minio.sh        # -> ops/backup/artifacts/hrm-minio-hrm-dev-<ts>.tar.gz.gpg

./ops/backup/restore-drill.sh       # restores the newest Postgres backup into a
                                     # scratch DB, runs all verification checks, cleans up
```

All three scripts read config from `apps/api/.env` where relevant (DB
container name/credentials, `S3_*`) and default to this repo's own
`docker-compose.yml` values otherwise — see each script's own header
comment for every override variable (`PG_CONTAINER`, `PG_DB`, `PG_USER`,
`PG_PASSWORD`, `APP_USER`, `APP_PASSWORD`, `BACKUP_OUT_DIR`).

**`BACKUP_ENCRYPTION_KEY` is required by all three scripts and is never
defaulted** — losing it makes every backup taken under it permanently
unrecoverable, so there is no "just works" fallback. See
[`DR-RUNBOOK.md`](./DR-RUNBOOK.md) § Encryption key handling for how this
should be sourced in a real (non-local) deployment.

## Recommended production schedule

Not wired up as an actual scheduler in this slice (see `DR-RUNBOOK.md` §
Backup schedule for the concrete `CronJob` recommendation and why it's
documented rather than built here):

```cron
0 2 * * *  backup-postgres.sh
30 2 * * * backup-minio.sh
```
