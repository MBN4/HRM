# Phase 5.1 — a thin wrapper around the stock postgres:16-alpine image that
# self-bootstraps as a streaming (hot standby) read replica of the
# `postgres` (primary) service. See replica-entrypoint.sh and
# docs/conventions/scaling-data-layer.md for the full write-up.
FROM postgres:16-alpine

COPY replica-entrypoint.sh /usr/local/bin/replica-entrypoint.sh
RUN chmod +x /usr/local/bin/replica-entrypoint.sh

ENTRYPOINT ["replica-entrypoint.sh"]
