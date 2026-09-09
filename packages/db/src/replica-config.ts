import { DbPoolConfig } from './pool-config';

/**
 * Phase 5.1 (see docs/conventions/scaling-data-layer.md) — pool
 * configuration for `readAppPrisma`, the client bound to a Postgres READ
 * REPLICA rather than the primary. Mirrors `pool-config.ts`'s own shape
 * exactly (a separate, independently-sized bounded pool + `pool_timeout`,
 * same 0.10 exhaustion-fails-fast posture) so replica reads get the SAME
 * connection-pool protection every other client in this system already
 * has, rather than a second, unprotected code path.
 */
const DEFAULT_REPLICA_POOL_SIZE = 10;
const DEFAULT_REPLICA_POOL_TIMEOUT_SECONDS = 5;

export function resolveReplicaPoolConfig(): DbPoolConfig {
  return {
    connectionLimit: Number(process.env.DB_REPLICA_POOL_SIZE ?? DEFAULT_REPLICA_POOL_SIZE),
    poolTimeoutSeconds: Number(process.env.DB_POOL_TIMEOUT_SECONDS ?? DEFAULT_REPLICA_POOL_TIMEOUT_SECONDS),
  };
}

/**
 * Whether a read replica is actually configured. `APP_REPLICA_DATABASE_URL`
 * is OPTIONAL and additive — every environment that doesn't set it (every
 * environment before this step, and any smaller deployment that chooses
 * not to run a replica) keeps `readAppPrisma` simply aliased to `appPrisma`
 * (see clients.ts), so read/write-splitting call sites degrade to "read
 * from the primary" with zero behavior change rather than failing.
 */
export function hasConfiguredReplica(): boolean {
  return Boolean(process.env.APP_REPLICA_DATABASE_URL);
}
