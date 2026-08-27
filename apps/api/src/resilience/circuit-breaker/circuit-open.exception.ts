/**
 * Thrown by `CircuitBreakerService.execute` instead of even ATTEMPTING the
 * wrapped call, whenever the named breaker is `OPEN` — this is what "fails
 * fast instead of piling up threads/connections" actually means: the
 * caller gets this immediately (no timeout wait, no outbound call at all)
 * rather than joining a queue behind an already-known-bad dependency.
 */
export class CircuitOpenError extends Error {
  constructor(readonly breakerName: string) {
    super(`Circuit "${breakerName}" is OPEN — failing fast without attempting the call.`);
    this.name = 'CircuitOpenError';
  }
}
