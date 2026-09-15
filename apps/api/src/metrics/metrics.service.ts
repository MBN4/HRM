import { Injectable } from '@nestjs/common';
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';
import type { CircuitState } from '@hrm/shared';

const CIRCUIT_STATE_VALUE: Record<CircuitState, number> = { CLOSED: 0, HALF_OPEN: 1, OPEN: 2 };

/**
 * Phase 5.4 — the single Prometheus registry for this process (api OR
 * worker — both construct one via the same `MetricsModule`). See
 * docs/conventions/observability-load.md for the full metric catalog and
 * WHY each one is shaped the way it is; the short version: every label
 * set here is BOUNDED (route template, method, status code, queue name,
 * cache name, breaker name, priority) — never a raw tenant id, user id, or
 * anything else with effectively-unbounded cardinality, which would
 * silently turn `/metrics` into a memory leak / a Prometheus ingestion
 * problem at real scale. Per-tenant observability belongs in structured
 * LOGS (tenant-correlated, see `PinoLoggerService`) and per-tenant
 * dashboards built FROM those logs — never in a Prometheus label.
 */
@Injectable()
export class MetricsService {
  readonly registry = new Registry();

  private readonly httpRequestDuration = new Histogram({
    name: 'hrm_http_request_duration_seconds',
    help: 'HTTP request duration in seconds.',
    labelNames: ['method', 'route', 'status_code'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [this.registry],
  });

  private readonly httpRequestsTotal = new Counter({
    name: 'hrm_http_requests_total',
    help: 'Total HTTP requests handled.',
    labelNames: ['method', 'route', 'status_code'],
    registers: [this.registry],
  });

  private readonly queueDepth = new Gauge({
    name: 'hrm_queue_depth',
    help: 'Current BullMQ job count per queue and state — the primary worker-autoscaling signal (see worker-hpa-keda.yaml).',
    labelNames: ['queue', 'state'],
    registers: [this.registry],
  });

  private readonly cacheHits = new Counter({
    name: 'hrm_cache_hits_total',
    help: 'Cache hits, by cache name (5.1 country-pack/org-structure/permissions caches).',
    labelNames: ['cache'],
    registers: [this.registry],
  });

  private readonly cacheMisses = new Counter({
    name: 'hrm_cache_misses_total',
    help: 'Cache misses, by cache name.',
    labelNames: ['cache'],
    registers: [this.registry],
  });

  private readonly circuitBreakerState = new Gauge({
    name: 'hrm_circuit_breaker_state',
    help: 'Circuit breaker state by name: 0=CLOSED, 1=HALF_OPEN, 2=OPEN.',
    labelNames: ['name'],
    registers: [this.registry],
  });

  private readonly rateLimitRejections = new Counter({
    name: 'hrm_rate_limit_rejections_total',
    help: 'Requests rejected with 429, by source (never labeled by tenant — unbounded cardinality).',
    labelNames: ['source'],
    registers: [this.registry],
  });

  private readonly loadShedRejections = new Counter({
    name: 'hrm_load_shed_rejections_total',
    help: 'Requests rejected (503) by load shedding, by priority.',
    labelNames: ['priority'],
    registers: [this.registry],
  });

  private readonly poolExhaustionRejections = new Counter({
    name: 'hrm_db_pool_exhaustion_rejections_total',
    help: 'Requests rejected (503) due to DB connection-pool exhaustion (Prisma P2024).',
    registers: [this.registry],
  });

  constructor() {
    // Free, standard Node process metrics (event loop lag, heap, GC,
    // active handles) — prom-client's own well-known default collector,
    // registered onto the SAME registry so one scrape gets both this
    // system's own metrics and baseline process health.
    collectDefaultMetrics({ register: this.registry, prefix: 'hrm_process_' });
  }

  recordHttpRequest(method: string, route: string, statusCode: number, durationSeconds: number): void {
    const labels = { method, route, status_code: String(statusCode) };
    this.httpRequestDuration.observe(labels, durationSeconds);
    this.httpRequestsTotal.inc(labels);
  }

  setQueueDepth(queue: string, state: string, value: number): void {
    this.queueDepth.set({ queue, state }, value);
  }

  recordCacheHit(cache: string): void {
    this.cacheHits.inc({ cache });
  }

  recordCacheMiss(cache: string): void {
    this.cacheMisses.inc({ cache });
  }

  setCircuitBreakerState(name: string, state: CircuitState): void {
    this.circuitBreakerState.set({ name }, CIRCUIT_STATE_VALUE[state]);
  }

  incRateLimitRejection(source: 'tenant' | 'api-key' | 'auth'): void {
    this.rateLimitRejections.inc({ source });
  }

  incLoadShedRejection(priority: string): void {
    this.loadShedRejections.inc({ priority });
  }

  incPoolExhaustion(): void {
    this.poolExhaustionRejections.inc();
  }

  async metricsText(): Promise<string> {
    return this.registry.metrics();
  }
}
