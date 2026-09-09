#!/bin/sh
# Phase 5.1 — runs once, on a brand-new primary data volume, right after
# initdb (Postgres's own /docker-entrypoint-initdb.d convention runs *.sql
# then *.sh files in this directory, in name order). `pg_hba.conf`'s
# "all" database keyword does NOT reliably cover physical replication
# connections on every Postgres version — an explicit `replication` line
# is the documented, unambiguous way to allow the `replicator` role (see
# 10-replication-role.sql) to open a streaming-replication connection from
# the replica's container. See docs/conventions/scaling-data-layer.md.
set -e
echo "host replication replicator all scram-sha-256" >> "$PGDATA/pg_hba.conf"
