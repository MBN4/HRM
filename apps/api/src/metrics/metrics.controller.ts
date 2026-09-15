import { Controller, Get, Header, UseGuards } from '@nestjs/common';
import { Public } from '../tenancy/public.decorator';
import { Priority } from '../resilience/load-shedding/priority.decorator';
import { MetricsAuthGuard } from './metrics-auth.guard';
import { MetricsService } from './metrics.service';

/**
 * Phase 5.4 — `GET /metrics`, Prometheus exposition format. `@Public()`
 * (no tenant to resolve for an infra endpoint) + `@Priority('CRITICAL')`
 * (the same reasoning `/health/live`/`/health/ready` already use — a
 * scrape must never be shed BY the load it's trying to help diagnose) +
 * `MetricsAuthGuard` (see that file's own doc comment for the "secured"
 * mechanism and its documented limits).
 */
@Controller()
export class MetricsController {
  constructor(private readonly metricsService: MetricsService) {}

  @Public()
  @Priority('CRITICAL')
  @UseGuards(MetricsAuthGuard)
  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  async metrics(): Promise<string> {
    return this.metricsService.metricsText();
  }
}
