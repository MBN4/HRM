import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { prisma } from '@hrm/db';
import { REDIS_CLIENT } from '../../redis/redis.constants';
import { ShutdownService } from '../shutdown/shutdown.service';

export interface ReadinessResult {
  ready: boolean;
  checks: { database: boolean; redis: boolean; shuttingDown: boolean };
}

/**
 * Backs `GET /health/ready` — see /CLAUDE.md § Conventions → Graceful
 * degradation + health. READY means: the database is reachable, Redis is
 * reachable, AND the process isn't mid-shutdown (see `ShutdownService`).
 * Deliberately uses the OWNER `prisma` client for its DB check (a plain
 * `SELECT 1`, no tenant data touched, no RLS concern — this is an
 * infrastructure liveness probe, not a tenant-scoped query) rather than
 * `withTenantContext`, which needs a real tenant id this check has none
 * of.
 */
@Injectable()
export class ReadinessService {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly shutdown: ShutdownService,
  ) {}

  async check(): Promise<ReadinessResult> {
    const [database, redis] = await Promise.all([this.checkDatabase(), this.checkRedis()]);
    const shuttingDown = this.shutdown.isShuttingDown;
    return { ready: database && redis && !shuttingDown, checks: { database, redis, shuttingDown } };
  }

  private async checkDatabase(): Promise<boolean> {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }

  private async checkRedis(): Promise<boolean> {
    try {
      return (await this.redis.ping()) === 'PONG';
    } catch {
      return false;
    }
  }
}
