#!/usr/bin/env bash
# Phase 6.2 — backups & DR (see ops/backup/DR-RUNBOOK.md).
#
# Runs a REAL restore drill against the live local Postgres cluster (never
# the live hrm_dev database — restores into a throwaway SCRATCH database
# inside the SAME hrm-postgres container, dropped at the end unless
# --keep is passed):
#
#   1. Decrypt the given (or, if omitted, the most recent) encrypted
#      backup-postgres.sh artifact.
#   2. Create a scratch database and pg_restore the dump into it.
#   3. Prove data integrity: row counts for a few real tables match
#      between the source (hrm_dev) and the restored scratch DB.
#   4. Prove RLS survives the restore: hrm_app (the SAME role, since roles
#      are cluster-wide, not per-database — see
#      docs/conventions/tenancy-rls.md) can query the scratch DB with NO
#      tenant context set only by failing loudly, and with a real tenant id
#      set only sees that tenant's own rows.
#   5. Prove audit_log's DB-level immutability (the `REVOKE UPDATE, DELETE
#      FROM hrm_app` from 0.9/5.2 — see docs/conventions/audit-custom-fields.md
#      and docs/conventions/partitioning-archival.md) survives the restore:
#      hrm_app cannot UPDATE/DELETE audit_log in the restored DB either.
#
# This is the single most important deliverable of this step — every
# assertion below is a REAL query against a REAL restored database, not a
# description of what should happen.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_DIR="${BACKUP_OUT_DIR:-$SCRIPT_DIR/artifacts}"

PG_CONTAINER="${PG_CONTAINER:-hrm-postgres}"
PG_DB="${PG_DB:-hrm_dev}"
PG_USER="${PG_USER:-hrm}"
PG_PASSWORD="${PG_PASSWORD:-hrm_dev_password}"
APP_USER="${APP_USER:-hrm_app}"
APP_PASSWORD="${APP_PASSWORD:-hrm_app_dev_password}"

: "${BACKUP_ENCRYPTION_KEY:?BACKUP_ENCRYPTION_KEY must be set — see ops/backup/DR-RUNBOOK.md.}"

KEEP=0
BACKUP_FILE=""
for arg in "$@"; do
  case "$arg" in
    --keep) KEEP=1 ;;
    *) BACKUP_FILE="$arg" ;;
  esac
done

if [ -z "$BACKUP_FILE" ]; then
  BACKUP_FILE="$(ls -t "$OUT_DIR"/hrm-postgres-*.dump.gpg 2>/dev/null | head -1)"
fi
if [ -z "$BACKUP_FILE" ] || [ ! -f "$BACKUP_FILE" ]; then
  echo "[restore-drill] no encrypted Postgres backup found — run backup-postgres.sh first." >&2
  exit 1
fi

echo "[restore-drill] using backup artifact: $BACKUP_FILE"

WORK_DIR="$(mktemp -d)"
SCRATCH_DB="hrm_dr_drill_$(date -u +%Y%m%d%H%M%S)"

cleanup() {
  rm -rf "$WORK_DIR"
  if [ "$KEEP" -eq 0 ]; then
    echo "[restore-drill] dropping scratch database '$SCRATCH_DB'..."
    docker exec -e PGPASSWORD="$PG_PASSWORD" "$PG_CONTAINER" \
      psql -U "$PG_USER" -d postgres -v ON_ERROR_STOP=1 \
      -c "DROP DATABASE IF EXISTS \"$SCRATCH_DB\";" >/dev/null
  else
    echo "[restore-drill] --keep passed: leaving '$SCRATCH_DB' in place for manual inspection."
  fi
}
trap cleanup EXIT

FAILED=0
pass() { echo "  [PASS] $1"; }
fail() { echo "  [FAIL] $1"; FAILED=1; }

# --- 1. Decrypt -------------------------------------------------------
echo
echo "=== 1. Decrypting backup artifact ==="
DECRYPTED_DUMP="$WORK_DIR/restore.dump"
printf '%s' "$BACKUP_ENCRYPTION_KEY" | gpg --batch --yes --passphrase-fd 0 \
  --decrypt --output "$DECRYPTED_DUMP" "$BACKUP_FILE"
echo "  decrypted to $DECRYPTED_DUMP ($(stat -c%s "$DECRYPTED_DUMP" 2>/dev/null || stat -f%z "$DECRYPTED_DUMP") bytes)"

# --- 2. Create scratch DB + restore -----------------------------------
echo
echo "=== 2. Restoring into scratch database '$SCRATCH_DB' ==="
docker exec -e PGPASSWORD="$PG_PASSWORD" "$PG_CONTAINER" \
  psql -U "$PG_USER" -d postgres -v ON_ERROR_STOP=1 \
  -c "CREATE DATABASE \"$SCRATCH_DB\" OWNER \"$PG_USER\";"

# pg_restore exits non-zero on warnings (e.g. "role does not exist" for
# roles owned by other databases in the cluster) even on an otherwise
# successful restore, so this deliberately doesn't `set -e` around it —
# the row-count/RLS/immutability checks below are the real proof the
# restore worked, not pg_restore's own exit code.
set +e
docker exec -i -e PGPASSWORD="$PG_PASSWORD" "$PG_CONTAINER" \
  pg_restore -U "$PG_USER" -d "$SCRATCH_DB" --no-owner < "$DECRYPTED_DUMP" \
  > "$WORK_DIR/restore.log" 2>&1
RESTORE_EXIT=$?
set -e
echo "  pg_restore exit code: $RESTORE_EXIT (see $WORK_DIR/restore.log for full output)"
tail -5 "$WORK_DIR/restore.log" | sed 's/^/  | /'

# --- 3. Data integrity: row counts source vs. restored -----------------
echo
echo "=== 3. Data integrity: row counts (source hrm_dev vs. restored $SCRATCH_DB) ==="
for TABLE in tenants users employees branches audit_log; do
  SRC_COUNT="$(docker exec -e PGPASSWORD="$PG_PASSWORD" "$PG_CONTAINER" \
    psql -U "$PG_USER" -d "$PG_DB" -tAc "SELECT count(*) FROM \"$TABLE\";")"
  DST_COUNT="$(docker exec -e PGPASSWORD="$PG_PASSWORD" "$PG_CONTAINER" \
    psql -U "$PG_USER" -d "$SCRATCH_DB" -tAc "SELECT count(*) FROM \"$TABLE\";")"
  if [ "$SRC_COUNT" = "$DST_COUNT" ]; then
    pass "$TABLE: source=$SRC_COUNT restored=$DST_COUNT (match)"
  else
    fail "$TABLE: source=$SRC_COUNT restored=$DST_COUNT (MISMATCH)"
  fi
done

# Sample-row check: a specific tenant's row content matches byte-for-byte.
SAMPLE_TENANT_ID="$(docker exec -e PGPASSWORD="$PG_PASSWORD" "$PG_CONTAINER" \
  psql -U "$PG_USER" -d "$PG_DB" -tAc "SELECT id FROM tenants ORDER BY id LIMIT 1;")"
SRC_ROW="$(docker exec -e PGPASSWORD="$PG_PASSWORD" "$PG_CONTAINER" \
  psql -U "$PG_USER" -d "$PG_DB" -tAc "SELECT slug, name, status FROM tenants WHERE id = '$SAMPLE_TENANT_ID';")"
DST_ROW="$(docker exec -e PGPASSWORD="$PG_PASSWORD" "$PG_CONTAINER" \
  psql -U "$PG_USER" -d "$SCRATCH_DB" -tAc "SELECT slug, name, status FROM tenants WHERE id = '$SAMPLE_TENANT_ID';")"
if [ "$SRC_ROW" = "$DST_ROW" ]; then
  pass "sample tenant row ($SAMPLE_TENANT_ID) content matches: $SRC_ROW"
else
  fail "sample tenant row ($SAMPLE_TENANT_ID) MISMATCH: source='$SRC_ROW' restored='$DST_ROW'"
fi

# --- 4. RLS survives the restore ---------------------------------------
echo
echo "=== 4. RLS on the restored database ==="

NO_CTX_OUTPUT="$(docker exec -e PGPASSWORD="$APP_PASSWORD" "$PG_CONTAINER" \
  psql -U "$APP_USER" -d "$SCRATCH_DB" -tAc "SELECT count(*) FROM branches;" 2>&1)" && NO_CTX_EXIT=0 || NO_CTX_EXIT=$?
if [ "$NO_CTX_EXIT" -ne 0 ] && echo "$NO_CTX_OUTPUT" | grep -qi "unrecognized configuration parameter\|current_setting"; then
  pass "hrm_app query with NO tenant context set fails loudly, as required: $(echo "$NO_CTX_OUTPUT" | tail -1)"
else
  fail "hrm_app query with no tenant context did NOT fail as expected (exit=$NO_CTX_EXIT): $NO_CTX_OUTPUT"
fi

RESTORED_TENANT_ID="$SAMPLE_TENANT_ID"
EXPECTED_BRANCH_COUNT="$(docker exec -e PGPASSWORD="$PG_PASSWORD" "$PG_CONTAINER" \
  psql -U "$PG_USER" -d "$PG_DB" -tAc "SELECT count(*) FROM branches WHERE tenant_id = '$RESTORED_TENANT_ID';")"
OTHER_TENANT_TOTAL="$(docker exec -e PGPASSWORD="$PG_PASSWORD" "$PG_CONTAINER" \
  psql -U "$PG_USER" -d "$PG_DB" -tAc "SELECT count(*) FROM branches WHERE tenant_id <> '$RESTORED_TENANT_ID';")"

SCOPED_COUNT="$(docker exec -e PGPASSWORD="$APP_PASSWORD" "$PG_CONTAINER" \
  psql -U "$APP_USER" -d "$SCRATCH_DB" -tAc \
  "SELECT set_config('app.current_tenant', '$RESTORED_TENANT_ID', false); SELECT count(*) FROM branches;" | tail -1)"

if [ "$SCOPED_COUNT" = "$EXPECTED_BRANCH_COUNT" ] && [ "$OTHER_TENANT_TOTAL" -gt 0 ]; then
  pass "hrm_app with app.current_tenant='$RESTORED_TENANT_ID' sees exactly that tenant's $SCOPED_COUNT branch(es) — $OTHER_TENANT_TOTAL branch(es) belonging to OTHER tenants stay invisible"
else
  fail "tenant-scoped read returned $SCOPED_COUNT, expected $EXPECTED_BRANCH_COUNT (other-tenant total: $OTHER_TENANT_TOTAL)"
fi

# --- 5. audit_log immutability survives the restore ---------------------
echo
echo "=== 5. audit_log DB-level immutability on the restored database ==="

UPDATE_OUTPUT="$(docker exec -e PGPASSWORD="$APP_PASSWORD" "$PG_CONTAINER" \
  psql -U "$APP_USER" -d "$SCRATCH_DB" -tAc \
  "SELECT set_config('app.current_tenant', '$RESTORED_TENANT_ID', false); UPDATE audit_log SET action = 'TAMPERED' WHERE tenant_id = '$RESTORED_TENANT_ID';" 2>&1)" && UPDATE_EXIT=0 || UPDATE_EXIT=$?
if [ "$UPDATE_EXIT" -ne 0 ] && echo "$UPDATE_OUTPUT" | grep -qi "permission denied"; then
  pass "hrm_app UPDATE against restored audit_log rejected: $(echo "$UPDATE_OUTPUT" | grep -i "error" | tail -1)"
else
  fail "hrm_app UPDATE against restored audit_log was NOT rejected (exit=$UPDATE_EXIT): $UPDATE_OUTPUT"
fi

DELETE_OUTPUT="$(docker exec -e PGPASSWORD="$APP_PASSWORD" "$PG_CONTAINER" \
  psql -U "$APP_USER" -d "$SCRATCH_DB" -tAc \
  "SELECT set_config('app.current_tenant', '$RESTORED_TENANT_ID', false); DELETE FROM audit_log WHERE tenant_id = '$RESTORED_TENANT_ID';" 2>&1)" && DELETE_EXIT=0 || DELETE_EXIT=$?
if [ "$DELETE_EXIT" -ne 0 ] && echo "$DELETE_OUTPUT" | grep -qi "permission denied"; then
  pass "hrm_app DELETE against restored audit_log rejected: $(echo "$DELETE_OUTPUT" | grep -i "error" | tail -1)"
else
  fail "hrm_app DELETE against restored audit_log was NOT rejected (exit=$DELETE_EXIT): $DELETE_OUTPUT"
fi

echo
if [ "$FAILED" -eq 0 ]; then
  echo "=== RESULT: ALL CHECKS PASSED ==="
else
  echo "=== RESULT: ONE OR MORE CHECKS FAILED — see [FAIL] lines above ===" >&2
fi
exit "$FAILED"
