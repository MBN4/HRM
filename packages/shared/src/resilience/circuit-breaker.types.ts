/**
 * Types for `apps/api/src/resilience/circuit-breaker/circuit-breaker.service.ts`
 * — the actual breaker implementation lives in `apps/api` because it's
 * Redis-backed (state must be shared across instances, same "state in
 * Redis, not process memory" posture as `RateLimiterService`), but the
 * shape is here so any future consumer (or a future admin UI surfacing
 * breaker state) can share one contract. See /CLAUDE.md § Conventions →
 * Circuit breakers.
 */
export const CIRCUIT_STATES = ['CLOSED', 'OPEN', 'HALF_OPEN'] as const;
export type CircuitState = (typeof CIRCUIT_STATES)[number];

export interface CircuitBreakerOptions {
  /** Failures within `windowSeconds` before the breaker trips OPEN. */
  failureThreshold: number;
  /** Rolling window the failure count is measured over. */
  windowSeconds: number;
  /** How long the breaker stays OPEN before allowing one HALF_OPEN trial call. */
  resetTimeoutSeconds: number;
  /** Per-call timeout — a call that exceeds this counts as a failure, same as a thrown error. */
  timeoutMs: number;
}

export const DEFAULT_CIRCUIT_BREAKER_OPTIONS: CircuitBreakerOptions = {
  failureThreshold: 5,
  windowSeconds: 30,
  resetTimeoutSeconds: 30,
  timeoutMs: 5000,
};
