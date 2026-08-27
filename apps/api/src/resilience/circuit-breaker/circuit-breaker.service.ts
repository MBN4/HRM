import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { CircuitBreakerOptions, CircuitState, DEFAULT_CIRCUIT_BREAKER_OPTIONS } from '@hrm/shared';
import { REDIS_CLIENT } from '../../redis/redis.constants';
import { CircuitOpenError } from './circuit-open.exception';

function keyFor(name: string, suffix: string): string {
  return `circuit:${name}:${suffix}`;
}

/**
 * A generic, Redis-backed circuit breaker (step 0.10) — see /CLAUDE.md §
 * Conventions → Circuit breakers. State lives in Redis (`state`,
 * `failures` (a `RateLimiterService`-style fixed-window counter),
 * `opened-at`), not process memory, so every API instance sees and
 * contributes to the SAME breaker for a given `name` — the same
 * "STATELESS, so horizontal scaling just works" posture as
 * `RateLimiterService`/`TenantRateLimitService`.
 *
 * State machine: `CLOSED` (normal) -> (>= `failureThreshold` failures
 * within `windowSeconds`) -> `OPEN` (every call fails fast with
 * `CircuitOpenError`, no attempt made) -> (`resetTimeoutSeconds` after
 * tripping) -> `HALF_OPEN` (trial calls are let through) -> a SUCCESSFUL
 * trial resets to `CLOSED`, a FAILED one trips back to `OPEN` immediately
 * (no need to re-accumulate `failureThreshold` failures — one failed
 * trial while half-open is enough to prove the dependency is still down).
 *
 * Deliberately does NOT coordinate a strictly-single trial call across
 * instances during `HALF_OPEN` (a short Redis lock narrows the window but
 * doesn't eliminate a race under true concurrency) — a documented,
 * accepted simplification: a handful of concurrent trial calls hitting an
 * still-recovering dependency during the brief `HALF_OPEN` window is a
 * far smaller cost than the coordination complexity of guaranteeing
 * exactly one, and the breaker still converges correctly either way.
 */
@Injectable()
export class CircuitBreakerService {
  private readonly logger = new Logger(CircuitBreakerService.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async execute<T>(name: string, fn: () => Promise<T>, options: Partial<CircuitBreakerOptions> = {}): Promise<T> {
    const opts: CircuitBreakerOptions = { ...DEFAULT_CIRCUIT_BREAKER_OPTIONS, ...options };
    const state = await this.transitionIfDue(name, opts);

    if (state === 'OPEN') {
      throw new CircuitOpenError(name);
    }

    try {
      const result = await this.withTimeout(fn(), opts.timeoutMs, name);
      await this.onSuccess(name, state);
      return result;
    } catch (error) {
      await this.onFailure(name, state, opts);
      throw error;
    }
  }

  async getState(name: string): Promise<CircuitState> {
    const state = await this.redis.get(keyFor(name, 'state'));
    return (state as CircuitState | null) ?? 'CLOSED';
  }

  /** Test/ops escape hatch — forces a breaker back to CLOSED (e.g. after manually confirming a dependency recovered). */
  async reset(name: string): Promise<void> {
    await this.redis.del(keyFor(name, 'state'), keyFor(name, 'failures'), keyFor(name, 'opened-at'));
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number, name: string): Promise<T> {
    let timer: NodeJS.Timeout;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Call through circuit "${name}" timed out after ${timeoutMs}ms.`)), timeoutMs);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      clearTimeout(timer!);
    }
  }

  private async transitionIfDue(name: string, opts: CircuitBreakerOptions): Promise<CircuitState> {
    const state = await this.getState(name);
    if (state !== 'OPEN') {
      return state;
    }

    const openedAtRaw = await this.redis.get(keyFor(name, 'opened-at'));
    const openedAt = openedAtRaw ? Number(openedAtRaw) : 0;
    const dueForTrial = Date.now() - openedAt >= opts.resetTimeoutSeconds * 1000;
    if (!dueForTrial) {
      return 'OPEN';
    }

    // Best-effort single-probe gate — see class doc comment for why this
    // isn't a hard guarantee under true cross-instance concurrency.
    const acquiredProbe = await this.redis.set(
      keyFor(name, 'half-open-lock'),
      '1',
      'PX',
      opts.resetTimeoutSeconds * 1000,
      'NX',
    );
    if (!acquiredProbe) {
      return 'OPEN';
    }

    await this.redis.set(keyFor(name, 'state'), 'HALF_OPEN' satisfies CircuitState);
    this.logger.log(`Circuit "${name}" is due for a trial call — moving OPEN -> HALF_OPEN.`);
    return 'HALF_OPEN';
  }

  private async onSuccess(name: string, priorState: CircuitState): Promise<void> {
    if (priorState === 'CLOSED') {
      return;
    }
    await this.redis.del(keyFor(name, 'state'), keyFor(name, 'failures'), keyFor(name, 'opened-at'));
    this.logger.log(`Circuit "${name}" trial call succeeded — HALF_OPEN -> CLOSED.`);
  }

  private async onFailure(name: string, priorState: CircuitState, opts: CircuitBreakerOptions): Promise<void> {
    if (priorState === 'HALF_OPEN') {
      await this.trip(name);
      this.logger.warn(`Circuit "${name}" trial call failed — HALF_OPEN -> OPEN.`);
      return;
    }

    const failuresKey = keyFor(name, 'failures');
    const count = await this.redis.incr(failuresKey);
    if (count === 1) {
      await this.redis.expire(failuresKey, opts.windowSeconds);
    }
    if (count >= opts.failureThreshold) {
      await this.trip(name);
      this.logger.warn(`Circuit "${name}" tripped OPEN after ${count} failures within ${opts.windowSeconds}s.`);
    }
  }

  private async trip(name: string): Promise<void> {
    await this.redis.set(keyFor(name, 'state'), 'OPEN' satisfies CircuitState);
    await this.redis.set(keyFor(name, 'opened-at'), String(Date.now()));
  }
}
