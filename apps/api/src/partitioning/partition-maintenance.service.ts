import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { prisma } from '@hrm/db';
import { PARTITION_MAINTENANCE_QUEUE } from '../queue/queue.constants';
import {
  PARTITIONED_TABLES,
  PARTITION_MAINTENANCE_ORCHESTRATOR_CRON,
  PARTITION_MAINTENANCE_ORCHESTRATOR_JOB_ID,
} from './partitioning.constants';

const JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential' as const, delay: 1000 },
  removeOnComplete: { age: 3600 },
  removeOnFail: false,
};

const DEFAULT_LOOKAHEAD_MONTHS = 3;

/**
 * AUTOMATED partition management (step 5.2) — see
 * docs/conventions/partitioning-archival.md. Keeps every managed table (see
 * `PARTITIONED_TABLES`) supplied with monthly partitions from (current
 * month - 1) through (current month + that table's own configured
 * `lookaheadMonths`), so a write NEVER hits a missing partition — no manual
 * partition creation anywhere in this codebase. The SAME scheduled-BullMQ-
 * orchestrator shape `AnalyticsRollupService` (1.5) established (see that
 * class's own doc comment for the full "why a repeatable job, why
 * `onModuleInit`, idempotent re-registration" write-up, not repeated here).
 *
 * Always runs through the OWNER `prisma` client, never `appPrisma` —
 * creating a partition is DDL, and `hrm_app` holds no `CREATE` privilege on
 * the schema at all (see the `partition_high_growth_tables` migration's own
 * `REVOKE` on the underlying `hrm_ensure_range_partitions` function) — this
 * is infra maintenance, not a tenant-scoped operation, the same class of
 * owner-client-only work `AnalyticsRollupService.enqueueForEveryLiveTenant`'s
 * own `Tenant.findMany` already is.
 */
@Injectable()
export class PartitionMaintenanceService implements OnModuleInit {
  private readonly logger = new Logger(PartitionMaintenanceService.name);

  constructor(@InjectQueue(PARTITION_MAINTENANCE_QUEUE) private readonly queue: Queue) {}

  async onModuleInit(): Promise<void> {
    await this.queue.add(
      'ensure-partitions',
      {},
      { ...JOB_OPTIONS, repeat: { pattern: PARTITION_MAINTENANCE_ORCHESTRATOR_CRON }, jobId: PARTITION_MAINTENANCE_ORCHESTRATOR_JOB_ID },
    );
    this.logger.log(`Registered the daily partition-maintenance orchestrator ("${PARTITION_MAINTENANCE_ORCHESTRATOR_CRON}" UTC).`);
  }

  /**
   * Ensures every managed table has partitions covering its own configured
   * lookahead window — called by the scheduled job AND by the manual
   * `POST /platform/partitioning/ensure` trigger. Idempotent: the
   * underlying `hrm_ensure_range_partitions` Postgres function checks
   * existence before creating (see the migration), so calling this
   * redundantly is always safe and creates zero duplicates. Returns how
   * many NEW partitions were created per table (0 on a normal, already-
   * caught-up run).
   */
  async ensureAllPartitions(): Promise<Record<string, number>> {
    const created: Record<string, number> = {};

    for (const spec of PARTITIONED_TABLES) {
      const config = await prisma.partitionedTableConfig.findUnique({ where: { tableName: spec.tableName } });
      const lookaheadMonths = config?.lookaheadMonths ?? DEFAULT_LOOKAHEAD_MONTHS;

      const before = await this.countPartitions(spec.physicalTable);

      const now = new Date();
      const fromMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
      const toMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + lookaheadMonths, 1));

      await prisma.$executeRaw`SELECT hrm_ensure_range_partitions(${spec.physicalTable}, ${spec.partitionPrefix}, ${fromMonth}::date, ${toMonth}::date)`;

      const after = await this.countPartitions(spec.physicalTable);
      created[spec.tableName] = after - before;
      if (after - before > 0) {
        this.logger.log(`Created ${after - before} new partition(s) for "${spec.physicalTable}".`);
      }
    }

    return created;
  }

  private async countPartitions(physicalTable: string): Promise<number> {
    const rows = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT count(*)::bigint AS count
      FROM pg_inherits i
      JOIN pg_class parent ON parent.oid = i.inhparent
      WHERE parent.relname = ${physicalTable}
    `;
    return Number(rows[0]?.count ?? 0);
  }
}
