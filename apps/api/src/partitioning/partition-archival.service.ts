import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { prisma } from '@hrm/db';
import { StorageService } from '../storage/storage.service';
import { PARTITION_ARCHIVAL_QUEUE } from '../queue/queue.constants';
import {
  PARTITIONED_TABLES,
  PARTITION_ARCHIVAL_ORCHESTRATOR_CRON,
  PARTITION_ARCHIVAL_ORCHESTRATOR_JOB_ID,
  isWellFormedPartitionName,
  type PartitionedTableSpec,
} from './partitioning.constants';
import { PartitionStatusService, type PartitionInfo } from './partition-status.service';

const JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 2000 },
  removeOnComplete: { age: 3600 },
  removeOnFail: false,
};

export interface ArchivalResult {
  tableName: string;
  partitionName: string;
  rowCount: number;
  storageKey: string;
}

/**
 * Archival / retention (step 5.2) — see
 * docs/conventions/partitioning-archival.md § Retention & archival. For
 * every managed table with `archiveEnabled`, finds partitions whose range
 * has fully aged past that table's configured `retentionMonths` and not
 * yet archived, and for each: exports every row to a gzip-compressed JSONL
 * object in the SAME S3/MinIO bucket `StorageService` already manages,
 * THEN (only once that export has durably succeeded) detaches and drops
 * the partition, recording an `ArchivedPartition` row as the documented
 * retrieval path. The SAME scheduled-BullMQ-orchestrator shape every prior
 * scheduled job in this codebase establishes — see
 * `AnalyticsRollupService`'s own doc comment for the full write-up.
 *
 * **Order matters, and is the actual safety property being proven**: the
 * export is written to object storage and only THEN is the partition
 * detached+dropped (inside one DB transaction with the `ArchivedPartition`
 * insert, so a mid-way failure leaves the partition still attached, never
 * "detached but not recorded"). A failed upload never touches the hot
 * table at all — there is no code path that drops data before it is
 * durably archived elsewhere.
 */
@Injectable()
export class PartitionArchivalService implements OnModuleInit {
  private readonly logger = new Logger(PartitionArchivalService.name);

  constructor(
    @InjectQueue(PARTITION_ARCHIVAL_QUEUE) private readonly queue: Queue,
    private readonly status: PartitionStatusService,
    private readonly storage: StorageService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.queue.add(
      'archive-sweep',
      {},
      { ...JOB_OPTIONS, repeat: { pattern: PARTITION_ARCHIVAL_ORCHESTRATOR_CRON }, jobId: PARTITION_ARCHIVAL_ORCHESTRATOR_JOB_ID },
    );
    this.logger.log(`Registered the monthly partition-archival orchestrator ("${PARTITION_ARCHIVAL_ORCHESTRATOR_CRON}" UTC).`);
  }

  /**
   * Runs a full archival sweep across every managed table — called by the
   * scheduled job AND the manual `POST /platform/partitioning/archive`
   * trigger. Archival eligibility is decided ONLY from the PLATFORM
   * DEFAULT `retentionMonths` (see `PartitionRetentionService`'s own doc
   * comment for why a tenant-specific override cannot yet drive this — a
   * partition spans every tenant's rows for its date range).
   */
  async runArchivalSweep(): Promise<ArchivalResult[]> {
    const results: ArchivalResult[] = [];

    for (const spec of PARTITIONED_TABLES) {
      const config = await prisma.partitionedTableConfig.findUnique({ where: { tableName: spec.tableName } });
      if (!config?.archiveEnabled) {
        continue;
      }

      const cutoff = monthsAgo(config.retentionMonths);
      const partitions = await this.status.listPartitions(spec.physicalTable);
      const alreadyArchived = new Set(
        (
          await prisma.archivedPartition.findMany({
            where: { tableName: spec.tableName },
            select: { partitionName: true },
          })
        ).map((row) => row.partitionName),
      );

      for (const partition of partitions) {
        if (alreadyArchived.has(partition.partitionName) || partition.rangeEnd > cutoff) {
          continue;
        }
        if (!isWellFormedPartitionName(spec.partitionPrefix, partition.partitionName)) {
          this.logger.warn(`Skipping unexpected partition name "${partition.partitionName}" on "${spec.physicalTable}" — not archiving.`);
          continue;
        }

        const result = await this.archiveOnePartition(spec, partition);
        results.push(result);
      }
    }

    return results;
  }

  private async archiveOnePartition(spec: PartitionedTableSpec, partition: PartitionInfo): Promise<ArchivalResult> {
    // 1. Export every row FIRST. `partition.partitionName` was already
    // validated against `isWellFormedPartitionName` by the caller before
    // this method is ever invoked — it comes from Postgres's own system
    // catalogs (pg_class), never user input, but every dynamic-identifier
    // code path in this module still validates before interpolating,
    // defense-in-depth consistent with this codebase's "no single layer
    // trusted alone" posture.
    const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(`SELECT * FROM "${partition.partitionName}"`);
    const jsonl = rows.map((row) => JSON.stringify(row, jsonReplacer)).join('\n');
    const gzipped = gzipSync(Buffer.from(jsonl, 'utf8'));
    const checksum = createHash('sha256').update(gzipped).digest('hex');
    const storageKey = `archives/${spec.physicalTable}/${partition.partitionName}.jsonl.gz`;

    // 2. Upload MUST durably succeed before we ever touch the hot table.
    await this.storage.uploadObject({ key: storageKey, body: gzipped, contentType: 'application/gzip' });

    // 3. Only now: detach + drop + record, atomically. If the DROP or the
    // ArchivedPartition insert fails, the DETACH rolls back too — the
    // partition is left exactly as it was (still attached, still queryable
    // through the parent), never "detached but unrecorded".
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`ALTER TABLE "${spec.physicalTable}" DETACH PARTITION "${partition.partitionName}"`);
      await tx.$executeRawUnsafe(`DROP TABLE "${partition.partitionName}"`);
      await tx.archivedPartition.create({
        data: {
          tableName: spec.tableName,
          partitionName: partition.partitionName,
          rangeStart: partition.rangeStart,
          rangeEnd: partition.rangeEnd,
          rowCount: rows.length,
          storageKey,
          checksumSha256: checksum,
        },
      });
    });

    this.logger.log(`Archived partition "${partition.partitionName}" (${rows.length} rows) of "${spec.physicalTable}" to ${storageKey}.`);
    return { tableName: spec.tableName, partitionName: partition.partitionName, rowCount: rows.length, storageKey };
  }
}

function monthsAgo(months: number): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - months, now.getUTCDate()));
}

function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}
