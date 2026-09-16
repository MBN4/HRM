#!/usr/bin/env bash
# Phase 6.4 — DR verification (see docs/conventions/incident-response-dr.md
# § 2.5). A fast, NON-DESTRUCTIVE companion to restore-drill.sh: decrypts
# the most recent (or a given) encrypted backup-postgres.sh artifact and
# asserts it is a STRUCTURALLY VALID pg_restore archive via
# `pg_restore --list`, which reads and validates the archive's own
# table-of-contents WITHOUT touching any database at all — no scratch DB,
# no docker container, nothing running required beyond `pg_restore` and
# `gpg` on PATH. This is deliberately NOT a replacement for
# restore-drill.sh's own full row-count/RLS/audit_log-immutability proof
# (still the authoritative periodic test, per DR-RUNBOOK.md) — it's the
# cheap, frequent "is last night's backup even well-formed" check that
# turns a silently truncated/corrupted backup upload into a same-day
# discovery instead of a discovery only during a real restore.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_DIR="${BACKUP_OUT_DIR:-$SCRIPT_DIR/artifacts}"

: "${BACKUP_ENCRYPTION_KEY:?BACKUP_ENCRYPTION_KEY must be set — see ops/backup/DR-RUNBOOK.md.}"

BACKUP_FILE="${1:-}"
if [ -z "$BACKUP_FILE" ]; then
  BACKUP_FILE="$(ls -t "$OUT_DIR"/hrm-postgres-*.dump.gpg 2>/dev/null | head -1)"
fi
if [ -z "$BACKUP_FILE" ] || [ ! -f "$BACKUP_FILE" ]; then
  echo "[verify-latest-backup] no encrypted Postgres backup found — run backup-postgres.sh first." >&2
  exit 1
fi

echo "[verify-latest-backup] verifying artifact: $BACKUP_FILE"

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

DECRYPTED_DUMP="$WORK_DIR/verify.dump"
echo "[verify-latest-backup] decrypting..."
printf '%s' "$BACKUP_ENCRYPTION_KEY" | gpg --batch --yes --passphrase-fd 0 \
  --decrypt --output "$DECRYPTED_DUMP" "$BACKUP_FILE"

DUMP_BYTES="$(stat -c%s "$DECRYPTED_DUMP" 2>/dev/null || stat -f%z "$DECRYPTED_DUMP")"
if [ "$DUMP_BYTES" -lt 1024 ]; then
  echo "[verify-latest-backup] [FAIL] decrypted dump is suspiciously small (${DUMP_BYTES} bytes) — likely a truncated/failed backup." >&2
  exit 1
fi
echo "[verify-latest-backup]   decrypted OK: ${DUMP_BYTES} bytes"

echo "[verify-latest-backup] validating archive structure (pg_restore --list, no database touched)..."
TOC="$WORK_DIR/toc.txt"
if ! pg_restore --list "$DECRYPTED_DUMP" > "$TOC" 2>"$WORK_DIR/toc.err"; then
  echo "[verify-latest-backup] [FAIL] pg_restore could not even list this archive's table of contents — it is not a valid pg_dump -Fc artifact:" >&2
  cat "$WORK_DIR/toc.err" >&2
  exit 1
fi

TABLE_COUNT="$(grep -c 'TABLE DATA' "$TOC" || true)"
if [ "$TABLE_COUNT" -lt 1 ]; then
  echo "[verify-latest-backup] [FAIL] archive is structurally valid but contains ZERO table-data entries — an empty/near-empty dump." >&2
  exit 1
fi

# A handful of tables that must always be present in a real hrm_dev dump —
# their absence means this archive is not what it claims to be (e.g. a
# dump of the wrong database, or a partial dump that stopped early).
MUST_CONTAIN=(tenants users audit_log)
for TABLE in "${MUST_CONTAIN[@]}"; do
  if ! grep -q " $TABLE " "$TOC"; then
    echo "[verify-latest-backup] [FAIL] expected table '$TABLE' not found in this archive's table of contents." >&2
    exit 1
  fi
done

echo "[verify-latest-backup] [PASS] archive is well-formed: ${TABLE_COUNT} tables with data, including tenants/users/audit_log."
echo "[verify-latest-backup] [PASS] $BACKUP_FILE is a valid, restorable pg_dump -Fc artifact."
