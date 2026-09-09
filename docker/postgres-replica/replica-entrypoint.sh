#!/bin/sh
# Phase 5.1 — data-layer scale hardening (see docs/conventions/scaling-data-layer.md).
#
# Bootstraps this container as a Postgres 16 streaming (hot standby) READ
# REPLICA of the `postgres` (primary) service, on first start only:
#   - If $PGDATA is empty, clones the primary via `pg_basebackup -R`, which
#     both copies the primary's data AND writes `standby.signal` +
#     `primary_conninfo` into postgresql.auto.conf for us — no manual
#     recovery.conf/standby.signal wrangling needed on Postgres 12+.
#   - Retries the clone until the primary is reachable (it may still be
#     starting up when this container starts, e.g. on a fresh
#     `docker compose up`).
#   - Then hands off to the STOCK image entrypoint (`docker-entrypoint.sh
#     postgres`), which fixes ownership (we run the clone step as root,
#     matching how the base image's own entrypoint always fixes ownership
#     before dropping to the `postgres` user) and starts Postgres normally
#     — which, seeing `standby.signal`, starts in hot-standby/recovery mode
#     and begins streaming from the primary instead of accepting writes.
#
# A restart with a non-empty $PGDATA just starts Postgres directly — no
# re-clone, replication resumes from where it left off (WAL streaming, not
# a full re-copy).
set -e

if [ -z "$(ls -A "$PGDATA" 2>/dev/null)" ]; then
  echo "[postgres-replica] PGDATA is empty — cloning primary ($PRIMARY_HOST:$PRIMARY_PORT) via pg_basebackup..."
  until PGPASSWORD="$REPLICATION_PASSWORD" pg_basebackup \
    -h "$PRIMARY_HOST" -p "$PRIMARY_PORT" -U "$REPLICATION_USER" \
    -D "$PGDATA" -Fp -Xs -P -R -c fast; do
    echo "[postgres-replica] primary not ready yet, retrying in 2s..."
    sleep 2
  done
  chmod 700 "$PGDATA"
  echo "[postgres-replica] clone complete — standby.signal + primary_conninfo written by pg_basebackup -R."
else
  echo "[postgres-replica] PGDATA already populated — resuming as standby, no re-clone."
fi

exec docker-entrypoint.sh postgres
