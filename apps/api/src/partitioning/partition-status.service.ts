import { Injectable } from '@nestjs/common';
import { prisma } from '@hrm/db';
import { PARTITIONED_TABLES } from './partitioning.constants';

export interface PartitionInfo {
  partitionName: string;
  rangeStart: Date;
  rangeEnd: Date;
  /** Postgres's own planner estimate (`pg_class.reltuples`) — cheap (no table scan), exact enough for an admin status view; refreshed by `ANALYZE`/autovacuum, same caveat every `EXPLAIN`-adjacent estimate in Postgres carries. */
  approxRowCount: number;
}

interface RawPartitionRow {
  partition_name: string;
  bound_expr: string;
  approx_row_count: bigint;
}

// `pg_get_expr(relpartbound, oid)` renders e.g. `FOR VALUES FROM ('2026-08-01 00:00:00') TO ('2026-09-01 00:00:00')`.
const BOUND_PATTERN = /FROM \('([^']+)'\) TO \('([^']+)'\)/;

/**
 * Introspects the REAL partition layout of a managed table directly from
 * Postgres system catalogs (`pg_inherits`/`pg_class`) — no separate
 * bookkeeping table to keep in sync, the partition catalog itself IS the
 * source of truth. Backs both `GET /platform/partitioning/status` and
 * `PartitionArchivalService`'s own eligibility sweep (see
 * docs/conventions/partitioning-archival.md).
 */
@Injectable()
export class PartitionStatusService {
  async listPartitions(physicalTable: string): Promise<PartitionInfo[]> {
    const rows = await prisma.$queryRaw<RawPartitionRow[]>`
      SELECT
        child.relname AS partition_name,
        pg_get_expr(child.relpartbound, child.oid) AS bound_expr,
        child.reltuples::bigint AS approx_row_count
      FROM pg_inherits i
      JOIN pg_class parent ON parent.oid = i.inhparent
      JOIN pg_class child ON child.oid = i.inhrelid
      WHERE parent.relname = ${physicalTable}
      ORDER BY child.relname
    `;

    const result: PartitionInfo[] = [];
    for (const row of rows) {
      const match = BOUND_PATTERN.exec(row.bound_expr);
      if (!match) {
        continue;
      }
      result.push({
        partitionName: row.partition_name,
        rangeStart: new Date(match[1]),
        rangeEnd: new Date(match[2]),
        approxRowCount: Number(row.approx_row_count),
      });
    }
    return result;
  }

  async listAllTablesStatus(): Promise<Record<string, PartitionInfo[]>> {
    const result: Record<string, PartitionInfo[]> = {};
    for (const spec of PARTITIONED_TABLES) {
      result[spec.tableName] = await this.listPartitions(spec.physicalTable);
    }
    return result;
  }
}
