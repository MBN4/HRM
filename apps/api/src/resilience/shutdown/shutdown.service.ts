import { Injectable } from '@nestjs/common';

/**
 * The readiness-vs-liveness split's shared flag — see /CLAUDE.md §
 * Conventions → Graceful degradation + health and `main.ts`'s signal
 * handling. `main.ts` calls `beginShutdown()` the INSTANT a SIGTERM/SIGINT
 * is received, BEFORE actually closing anything — `/health/ready` starts
 * failing immediately (so an orchestrator's load balancer stops routing
 * new traffic here), while `/health/live` keeps reporting healthy and the
 * process keeps serving already-in-flight requests through the grace
 * period that follows. This is what makes the shutdown GRACEFUL rather
 * than an abrupt cutoff — see `main.ts` for the actual drain sequence.
 */
@Injectable()
export class ShutdownService {
  private shuttingDown = false;

  beginShutdown(): void {
    this.shuttingDown = true;
  }

  get isShuttingDown(): boolean {
    return this.shuttingDown;
  }
}
