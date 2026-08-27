import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { Public } from '../../tenancy/public.decorator';
import { Priority } from '../load-shedding/priority.decorator';
import { ReadinessResult, ReadinessService } from './readiness.service';

/**
 * Liveness vs. readiness, split per standard orchestrator convention (step
 * 0.10) — see /CLAUDE.md § Conventions → Graceful degradation + health.
 * `/health` (`AppController`, unchanged since 0.3) stays a bare liveness
 * check; `/health/live` here is the same thing under the conventional
 * path an orchestrator (Kubernetes, ECS, ...) expects, for a deployment
 * that wants to point its liveness probe at `/health/live` specifically.
 * `/health/ready` is the NEW, real readiness check — see
 * `ReadinessService`.
 */
@Controller('health')
export class HealthController {
  constructor(private readonly readiness: ReadinessService) {}

  @Public()
  @Priority('CRITICAL')
  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Public()
  @Priority('CRITICAL')
  @Get('ready')
  async ready(): Promise<ReadinessResult> {
    const result = await this.readiness.check();
    if (!result.ready) {
      throw new ServiceUnavailableException(result);
    }
    return result;
  }
}
