import { ConflictException, Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../../redis/redis.constants';

interface StoredRecord {
  status: 'IN_PROGRESS' | 'COMPLETED';
  result?: unknown;
}

const DEFAULT_TTL_SECONDS = 24 * 60 * 60;

/**
 * A reusable, Redis-backed idempotency primitive (step 0.10) — see
 * /CLAUDE.md § Conventions → Idempotency. Earmarked for payroll/billing
 * mutations later; any unsafe write can opt in today via
 * `@Idempotent()` + `IdempotencyInterceptor`, or call `execute` directly
 * from a service that isn't behind a route at all.
 *
 * Algorithm (the standard "claim, then cache the outcome" shape — the
 * same one most real idempotency-key implementations, e.g. Stripe's, use):
 *   1. `SET key IN_PROGRESS NX` — first caller for this key claims it.
 *   2. Caller who WON the claim runs `fn()`. On success, the result is
 *      cached under the same key (`COMPLETED`, replacing the
 *      `IN_PROGRESS` marker). On failure, the key is DELETED — a failed
 *      attempt must NOT poison future retries; only a recorded SUCCESS
 *      should ever be replayed.
 *   3. A caller who LOST the claim (key already existed): if the stored
 *      record is `COMPLETED`, the cached result is returned immediately
 *      — the actual replay-without-double-apply guarantee. If it's still
 *      `IN_PROGRESS` (a genuinely concurrent duplicate), this throws
 *      `409 Conflict` rather than blocking/polling — simpler, and correct
 *      for the common case (a client retrying after a timeout, not two
 *      truly simultaneous identical requests).
 *
 * HONEST LIMITATION: the `COMPLETED` marker is written once `fn()`
 * resolves. When `fn()` itself runs inside a still-open DB transaction
 * (e.g. called from within a `@UseInterceptors(IdempotencyInterceptor)`
 * route, which executes inside `TenantScopeInterceptor`'s held-open
 * transaction), there is a real — if narrow — window between "the handler
 * returned successfully" and "the transaction actually COMMITs" where a
 * commit failure would leave Redis believing the write succeeded when
 * Postgres never durably applied it. Closing this gap fully would need
 * cross-store two-phase coordination, out of scope here; this is the same
 * tradeoff most production idempotency-key implementations accept.
 */
@Injectable()
export class IdempotencyService {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async execute<T>(
    scope: string,
    idempotencyKey: string,
    fn: () => Promise<T>,
    ttlSeconds: number = DEFAULT_TTL_SECONDS,
  ): Promise<T> {
    const key = `idempotency:${scope}:${idempotencyKey}`;
    const inProgress: StoredRecord = { status: 'IN_PROGRESS' };
    const claimed = await this.redis.set(key, JSON.stringify(inProgress), 'EX', ttlSeconds, 'NX');

    if (!claimed) {
      const existingRaw = await this.redis.get(key);
      const existing = existingRaw ? (JSON.parse(existingRaw) as StoredRecord) : null;
      if (existing?.status === 'COMPLETED') {
        return existing.result as T;
      }
      throw new ConflictException(
        'A request with this Idempotency-Key is already in progress. Retry once it completes.',
      );
    }

    try {
      const result = await fn();
      const completed: StoredRecord = { status: 'COMPLETED', result };
      await this.redis.set(key, JSON.stringify(completed), 'EX', ttlSeconds);
      return result;
    } catch (error) {
      await this.redis.del(key);
      throw error;
    }
  }
}
