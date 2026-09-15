import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import IORedis from 'ioredis';
import { Queue } from 'bullmq';
import * as queueConstants from '../queue/queue.constants';
import { MetricsService } from './metrics.service';

const ALL_QUEUE_NAMES = Object.values(queueConstants);
const POLL_INTERVAL_MS = 15_000;

/**
 * Phase 5.4 — queue-depth metrics (`hrm_queue_depth`) for EVERY queue this
 * codebase registers (see `queue.constants.ts`), with NO changes to any of
 * the 15 `@Processor(...)` classes: `Queue.getJobCounts()` reads the same
 * waiting/active/delayed/failed counts a processor never needs to touch
 * itself. This IS the worker-autoscaling signal `worker-hpa-keda.yaml`
 * (5.3) reads directly from Redis (BullMQ's own `bull:<queue>:wait` list
 * length) — this metric is the SAME number, just also exposed on
 * `/metrics` for dashboards/alerts, not a second source of truth.
 *
 * ONE shared `ioredis` connection for all 15 `Queue` instances —
 * deliberately NOT one connection per queue. `Queue` (unlike `Worker`/
 * `QueueEvents`) issues only plain, non-blocking Redis commands, so
 * BullMQ's documented support for passing an EXISTING `ioredis` client as
 * `connection` (instead of connection options, which would make each
 * `Queue` open its own socket) is exactly the right fit here — 1 socket
 * instead of 15, closed via one `onModuleDestroy` (see below) rather than
 * 15 independent teardowns.
 *
 * Deliberately scoped to the DEPTH gauge only, not also per-job
 * duration/outcome metrics (which would need a `QueueEvents` instance PER
 * QUEUE — BullMQ's per-job completed/failed pub-sub, one dedicated
 * blocking-read connection each, since `QueueEvents` can't share a
 * connection with anything the way plain `Queue` can). Depth is the
 * metric this step's own brief explicitly asks for (the worker-
 * autoscaling signal); job-duration/outcome via `QueueEvents` is a real,
 * buildable follow-up, not built here — see
 * docs/conventions/observability-load.md.
 *
 * Uses its OWN plain `Queue` instances (not Nest's `@InjectQueue`)
 * deliberately: this runs in BOTH the api and worker processes
 * (`MetricsModule` is imported by `AppModule`, so both do), and
 * `@InjectQueue` would require this module to import EVERY feature
 * module's `BullModule.registerQueue(...)` call to get a DI token for
 * each — the plain BullMQ client constructor needs only the queue NAME +
 * the shared connection, so this stays a single, self-contained service
 * with zero import-graph coupling to the 16 feature modules that own a
 * queue.
 */
@Injectable()
export class QueueMetricsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(QueueMetricsService.name);
  private readonly queues: Queue[] = [];
  private connection?: IORedis;
  private pollTimer?: NodeJS.Timeout;

  constructor(
    private readonly metrics: MetricsService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    const url = this.config.get<string>('REDIS_URL');
    if (!url) {
      throw new Error('REDIS_URL is not set.');
    }
    this.connection = new IORedis(url, { maxRetriesPerRequest: null, lazyConnect: false });
    for (const name of ALL_QUEUE_NAMES) {
      this.queues.push(new Queue(name, { connection: this.connection }));
    }

    // Poll depths on an interval AND once immediately, so /metrics has a
    // real value from the first scrape rather than waiting a full
    // interval — the same "run once at startup, then on schedule" shape
    // every other scheduled job in this codebase already follows.
    void this.pollDepths();
    this.pollTimer = setInterval(() => void this.pollDepths(), POLL_INTERVAL_MS);
    this.pollTimer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
    }
    // Closing every `Queue` first (BullMQ's own graceful close) THEN
    // disconnecting the shared connection they all borrowed — the reverse
    // order (killing the connection while a `Queue.close()` is still
    // in-flight) is what produced the hang this class's own doc comment
    // describes, so this ordering is deliberate, not incidental.
    await Promise.all(this.queues.map((q) => q.close()));
    await this.connection?.quit().catch(() => this.connection?.disconnect());
  }

  private async pollDepths(): Promise<void> {
    for (const queue of this.queues) {
      try {
        const counts = await queue.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed');
        for (const [state, value] of Object.entries(counts)) {
          this.metrics.setQueueDepth(queue.name, state, value);
        }
      } catch (error) {
        // Redis transiently unreachable — skip this tick, the next poll
        // retries. A metrics-collection hiccup must never throw out of a
        // timer callback (that would crash the process for an
        // observability concern, exactly backwards).
        this.logger.warn(`Failed to poll depth for queue "${queue.name}": ${String(error)}`);
      }
    }
  }
}
