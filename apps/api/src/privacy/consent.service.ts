import { Injectable } from '@nestjs/common';
import type { ConsentRecord, Prisma } from '@hrm/db';
import type { ListConsentRecordsQuery, RecordConsentInput } from '@hrm/shared';

/**
 * Consent tracking (step 6.1) — see docs/conventions/privacy-residency.md.
 * A plain, tenant-scoped log: recording a new grant/revocation is always an
 * INSERT (never an update-in-place), so the full history of a subject's
 * consent decisions over time is preserved — the same "append, don't
 * overwrite" instinct `AttendanceRegularization`/`LeaveBalance.adjust`
 * already hold themselves to for their own auditable histories.
 */
@Injectable()
export class ConsentService {
  async record(tx: Prisma.TransactionClient, tenantId: string, recordedByUserId: string | null, input: RecordConsentInput): Promise<ConsentRecord> {
    const now = new Date();
    return tx.consentRecord.create({
      data: {
        tenantId,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        purpose: input.purpose,
        granted: input.granted,
        source: input.source,
        recordedByUserId,
        grantedAt: input.granted ? now : null,
        revokedAt: input.granted ? null : now,
      },
    });
  }

  list(tx: Prisma.TransactionClient, tenantId: string, query: ListConsentRecordsQuery): Promise<ConsentRecord[]> {
    return tx.consentRecord.findMany({
      where: {
        tenantId,
        subjectType: query.subjectType,
        subjectId: query.subjectId,
      },
      orderBy: { createdAt: 'desc' },
    });
  }
}
