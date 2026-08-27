import { Injectable } from '@nestjs/common';

/**
 * Test/demo-only fault injection — lets tests deterministically make a
 * stand-in "external dependency" fail or hang, so
 * `CircuitBreakerService`'s trip / fail-fast / half-open-recovery behavior
 * can be proven without a real flaky HTTP dependency. Not wired into any
 * real outbound call — see `NotificationDeliveryService`'s provider
 * `.send()` calls (updated by this step) for where the breaker wraps a
 * REAL dependency.
 */
@Injectable()
export class FlakyDependencyService {
  private shouldFail = false;
  private delayMs = 0;

  configure(options: { shouldFail?: boolean; delayMs?: number }): void {
    if (options.shouldFail !== undefined) {
      this.shouldFail = options.shouldFail;
    }
    if (options.delayMs !== undefined) {
      this.delayMs = options.delayMs;
    }
  }

  async call(): Promise<{ ok: true }> {
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }
    if (this.shouldFail) {
      throw new Error('Simulated dependency failure.');
    }
    return { ok: true };
  }
}
