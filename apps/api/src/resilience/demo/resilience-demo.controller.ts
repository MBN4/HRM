import { BadRequestException, Body, Controller, Get, Post, Query, UseInterceptors } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { TenantContextService } from '../../tenancy/tenant-context.service';
import { CircuitBreakerService } from '../circuit-breaker/circuit-breaker.service';
import { CircuitOpenError } from '../circuit-breaker/circuit-open.exception';
import { Idempotent } from '../idempotency/idempotent.decorator';
import { IdempotencyInterceptor } from '../idempotency/idempotency.interceptor';
import { Priority } from '../load-shedding/priority.decorator';
import { FlakyDependencyService } from './flaky-dependency.service';

const MAX_SLOW_MS = 60_000;
const DEMO_BREAKER_NAME = 'resilience-demo';

const configureFlakySchema = z.object({
  shouldFail: z.boolean().optional(),
  delayMs: z.number().int().min(0).max(30_000).optional(),
});
type ConfigureFlakyInput = z.infer<typeof configureFlakySchema>;

/**
 * The reference/proof surface for this step's resilience primitives — the
 * same role `GET /auth/rbac-demo` (0.4), `GET /licensing/demo/advanced-reporting`
 * (0.6), and `GET /i18n/demo` (0.9) already play for their respective
 * mechanisms: no real payroll/report/bulk-job module exists yet to
 * exercise circuit breakers, load shedding, or idempotency against, so
 * this proves each one end to end. See /CLAUDE.md § Conventions for the
 * full write-up of each mechanism this exercises.
 */
@Controller('resilience/demo')
export class ResilienceDemoController {
  private readonly idempotentCounters = new Map<string, number>();

  constructor(
    private readonly circuitBreaker: CircuitBreakerService,
    private readonly flaky: FlakyDependencyService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * Holds the request's own transaction open for `ms` (clamped) via a
   * real `pg_sleep` — proves both connection-pool exhaustion protection
   * (a concurrent caller against a deliberately tiny pool gets a clean
   * 503) and the request-timeout interceptor (a caller with a short
   * `REQUEST_TIMEOUT_MS` gets a clean 408) against a REAL held connection,
   * not a synthetic `setTimeout`.
   */
  @Get('slow')
  async slow(@Query('ms') ms?: string): Promise<{ sleptMs: number }> {
    const delayMs = Math.min(Number(ms ?? 1000), MAX_SLOW_MS);
    const tx = this.tenantContext.getTx();
    // `pg_sleep` returns `void`, which Prisma's raw-query deserializer
    // cannot handle directly — call it as a FROM-item instead and project
    // a literal, so only that (deserializable) column is ever read back.
    await tx.$queryRaw`SELECT 1 AS ok FROM pg_sleep(${delayMs / 1000})`;
    return { sleptMs: delayMs };
  }

  @Post('flaky/configure')
  configureFlaky(@Body(new ZodValidationPipe(configureFlakySchema)) body: ConfigureFlakyInput): { ok: true } {
    this.flaky.configure(body);
    return { ok: true };
  }

  /** Calls the fault-injectable dependency THROUGH the circuit breaker — a short timeout/threshold so tests can trip and recover it quickly. */
  @Get('breaker')
  async breaker(): Promise<{ ok: true }> {
    try {
      return await this.circuitBreaker.execute(DEMO_BREAKER_NAME, () => this.flaky.call(), {
        failureThreshold: 3,
        windowSeconds: 30,
        resetTimeoutSeconds: 2,
        timeoutMs: 300,
      });
    } catch (error) {
      if (error instanceof CircuitOpenError) {
        throw new BadRequestException({ circuitOpen: true, message: error.message });
      }
      throw error;
    }
  }

  @Get('breaker/state')
  async breakerState(): Promise<{ state: string }> {
    return { state: await this.circuitBreaker.getState(DEMO_BREAKER_NAME) };
  }

  /** Each call with a NEW Idempotency-Key increments (per tenant); replaying the SAME key returns the cached count instead of incrementing again. */
  @Post('idempotent')
  @UseInterceptors(IdempotencyInterceptor)
  @Idempotent()
  incrementIdempotent(): { count: number } {
    const tenantId = this.tenantContext.getContext().tenantId ?? 'platform';
    const next = (this.idempotentCounters.get(tenantId) ?? 0) + 1;
    this.idempotentCounters.set(tenantId, next);
    return { count: next };
  }

  /** Optional `ms` delay (clamped) so tests can hold many concurrent requests in-flight long enough to genuinely overlap — proving load shedding under real concurrency, not just a fast burst that resolves before it can build up. */
  @Get('low-priority')
  @Priority('LOW')
  async lowPriority(@Query('ms') ms?: string): Promise<{ ok: true; priority: 'LOW' }> {
    const delayMs = Math.min(Number(ms ?? 0), MAX_SLOW_MS);
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    return { ok: true, priority: 'LOW' };
  }

  @Get('critical')
  @Priority('CRITICAL')
  critical(): { ok: true; priority: 'CRITICAL' } {
    return { ok: true, priority: 'CRITICAL' };
  }
}
