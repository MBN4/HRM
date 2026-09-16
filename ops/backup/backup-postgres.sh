#!/usr/bin/env bash
# Phase 6.2 — backups & DR (see ops/backup/DR-RUNBOOK.md).
#
# Full logical dump of the primary Postgres database (custom format, -Fc —
# more restore-flexible than plain SQL: supports pg_restore's selective
# table/schema restore and parallel restore). Run with the OWNER role
# (hrm, via DATABASE_URL's credentials), matching every other piece of
# admin/migration tooling in this repo — never the RLS-restricted hrm_app
# role, which exists for request-time app queries only (see
# docs/conventions/tenancy-rls.md's two-DB-role design).
#
# pg_dump runs INSIDE the hrm-postgres container, not on the host:
# this dev machine's own pg_dump is v12, older than the server (16), and
# pg_dump refuses to dump from a server newer than itself. Running inside
# the container sidesteps the version mismatch entirely.
#
# pg_dump -Fc naturally handles the native PARTITION BY RANGE tables from
# 5.2 (attendance_records/audit_log/platform_audit_log) transparently — it
# dumps the partitioned parent plus every partition as one logical table,
# the same way any ordinary table is dumped; nothing partition-specific is
# needed here (see docs/conventions/partitioning-archival.md).
#
# The dump is encrypted at rest immediately (GPG symmetric AES-256) using
# BACKUP_ENCRYPTION_KEY and the plaintext dump is shredded — an unencrypted
# dump file never sits on disk. See DR-RUNBOOK.md for how this key should be
# sourced in a real deployment (never hardcoded, same posture as
# FIELD_ENCRYPTION_KEY/JWT_SECRET in apps/api/.env.example).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

PG_CONTAINER="${PG_CONTAINER:-hrm-postgres}"
PG_DB="${PG_DB:-hrm_dev}"
PG_USER="${PG_USER:-hrm}"
PG_PASSWORD="${PG_PASSWORD:-hrm_dev_password}"
OUT_DIR="${BACKUP_OUT_DIR:-$SCRIPT_DIR/artifacts}"

: "${BACKUP_ENCRYPTION_KEY:?BACKUP_ENCRYPTION_KEY must be set — see ops/backup/DR-RUNBOOK.md. Never hardcode this.}"

mkdir -p "$OUT_DIR"

TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DUMP_NAME="hrm-postgres-${PG_DB}-${TIMESTAMP}.dump"
DUMP_PATH="$OUT_DIR/$DUMP_NAME"
ENCRYPTED_PATH="${DUMP_PATH}.gpg"

echo "[backup-postgres] dumping database '$PG_DB' from container '$PG_CONTAINER' as owner role '$PG_USER'..."
docker exec -e PGPASSWORD="$PG_PASSWORD" "$PG_CONTAINER" \
  pg_dump -U "$PG_USER" -d "$PG_DB" -Fc > "$DUMP_PATH"

DUMP_BYTES="$(stat -c%s "$DUMP_PATH" 2>/dev/null || stat -f%z "$DUMP_PATH")"
echo "[backup-postgres] dump complete: $DUMP_PATH (${DUMP_BYTES} bytes)"

echo "[backup-postgres] encrypting (GPG symmetric, AES-256)..."
printf '%s' "$BACKUP_ENCRYPTION_KEY" | gpg --batch --yes --passphrase-fd 0 \
  --symmetric --cipher-algo AES256 --output "$ENCRYPTED_PATH" "$DUMP_PATH"

# Never leave the plaintext dump on disk once the encrypted copy exists.
shred -u "$DUMP_PATH" 2>/dev/null || rm -f "$DUMP_PATH"

ENCRYPTED_BYTES="$(stat -c%s "$ENCRYPTED_PATH" 2>/dev/null || stat -f%z "$ENCRYPTED_PATH")"
echo "[backup-postgres] done: $ENCRYPTED_PATH (${ENCRYPTED_BYTES} bytes, encrypted)"
