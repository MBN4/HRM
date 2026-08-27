import { Injectable } from '@nestjs/common';

/**
 * The in-flight-request counter `LoadSheddingInterceptor` sheds against —
 * deliberately IN-PROCESS state, the one considered exception to this
 * step's "state in Redis" default (see /CLAUDE.md § Conventions → Load
 * shedding for the full reasoning): load shedding exists to protect THIS
 * process's own resources (event loop, memory, its slice of the DB pool)
 * from being overwhelmed, which is inherently a per-instance concern —
 * coordinating it through Redis would add a round trip to every single
 * request just to ask a question ("am I busy?") only the local process
 * can actually answer about itself.
 */
@Injectable()
export class SystemLoadService {
  private inFlight = 0;

  increment(): void {
    this.inFlight += 1;
  }

  decrement(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
  }

  get current(): number {
    return this.inFlight;
  }
}
