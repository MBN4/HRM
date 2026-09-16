#!/usr/bin/env bash
# Phase 6.2 — backups & DR (see ops/backup/DR-RUNBOOK.md).
#
# Backs up the MinIO/S3 object-storage bucket (S3_BUCKET, "hrm-dev"
# locally) — documents/payslips (1.1/2.1) AND the already-archived
# partition exports PartitionArchivalService writes under
# archives/<table>/<partition>.jsonl.gz (5.2, see
# docs/conventions/partitioning-archival.md). No `mc` binary is available
# either on this host or inside the hrm-minio container (verified: `which
# mc` fails both places), and no `aws` CLI is installed on this host
# either — rather than add a new CLI dependency, this shells out to
# minio-export.js, a small Node script reusing @aws-sdk/client-s3 (already
# a dependency of apps/api — see apps/api/src/storage/storage.service.ts),
# per this step's "no new dependency ecosystem" constraint.
#
# Reads S3_*/BACKUP_ENCRYPTION_KEY from apps/api/.env, the same real local
# values apps/api itself runs against — this script is a LOCAL/DEV
# convenience; a real deployment sources these from its own secret store
# (see deploy/k8s/base/secret.example.yaml's pattern), never from a
# checked-in .env file.
#
# The exported objects are tarred, then encrypted at rest the identical way
# backup-postgres.sh encrypts its dump (GPG symmetric AES-256) — the
# plaintext tarball and the temporary export directory are both removed
# once the encrypted artifact exists.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

if [ -f "$REPO_ROOT/apps/api/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$REPO_ROOT/apps/api/.env"
  set +a
fi

OUT_DIR="${BACKUP_OUT_DIR:-$SCRIPT_DIR/artifacts}"
: "${BACKUP_ENCRYPTION_KEY:?BACKUP_ENCRYPTION_KEY must be set — see ops/backup/DR-RUNBOOK.md. Never hardcode this.}"
: "${S3_BUCKET:?S3_BUCKET must be set (normally sourced from apps/api/.env).}"

mkdir -p "$OUT_DIR"

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

echo "[backup-minio] exporting bucket '$S3_BUCKET' via minio-export.js..."
node "$SCRIPT_DIR/minio-export.js" "$WORK_DIR"

TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
TARBALL="$OUT_DIR/hrm-minio-${S3_BUCKET}-${TIMESTAMP}.tar.gz"
tar -C "$WORK_DIR" -czf "$TARBALL" .
TARBALL_BYTES="$(stat -c%s "$TARBALL" 2>/dev/null || stat -f%z "$TARBALL")"
echo "[backup-minio] archive complete: $TARBALL (${TARBALL_BYTES} bytes)"

ENCRYPTED_PATH="${TARBALL}.gpg"
echo "[backup-minio] encrypting (GPG symmetric, AES-256)..."
printf '%s' "$BACKUP_ENCRYPTION_KEY" | gpg --batch --yes --passphrase-fd 0 \
  --symmetric --cipher-algo AES256 --output "$ENCRYPTED_PATH" "$TARBALL"

rm -f "$TARBALL"

ENCRYPTED_BYTES="$(stat -c%s "$ENCRYPTED_PATH" 2>/dev/null || stat -f%z "$ENCRYPTED_PATH")"
echo "[backup-minio] done: $ENCRYPTED_PATH (${ENCRYPTED_BYTES} bytes, encrypted)"
