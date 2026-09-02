import { Processor, WorkerHost } from '@nestjs/bullmq';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { Job } from 'bullmq';
import { withTenantContext } from '@hrm/db';
import { LMS_CERTIFICATION_EXPIRY_QUEUE } from '../queue/queue.constants';
import { determineComplianceBucket } from './lms-compliance.util';
import { CertificationExpiryService, LmsExpiryJobData } from './certification-expiry.service';

/**
 * The certification expiry-reminder job's WORKER side — see
 * `CertificationExpiryService`'s doc comment and docs/conventions/lms.md.
 * IDEMPOTENT BY CONSTRUCTION: `Certification.lastReminderBucket` is
 * compared against the freshly computed bucket every run — a re-run on an
 * unchanged certification recomputes the SAME bucket, sees
 * `lastReminderBucket` already matches, and sends nothing twice. This is
 * DB-native idempotency (no Redis `IdempotencyService` needed), the same
 * "a full recompute from source data is naturally idempotent" argument
 * `AttendanceDailySummary`'s own doc comment already makes for itself (see
 * docs/conventions/attendance.md), applied per-row here instead of via
 * delete+recreate.
 */
@Processor(LMS_CERTIFICATION_EXPIRY_QUEUE)
export class CertificationExpiryProcessor extends WorkerHost {
  constructor(
    private readonly expiryService: CertificationExpiryService,
    private readonly eventEmitter: EventEmitter2,
  ) {
    super();
  }

  async process(job: Job<LmsExpiryJobData | Record<string, never>>): Promise<void> {
    if (job.name === 'orchestrate') {
      await this.expiryService.enqueueForEveryLiveTenant();
      return;
    }

    const { tenantId } = job.data as LmsExpiryJobData;
    const today = new Date();

    await withTenantContext(tenantId, async (tx) => {
      const certifications = await tx.certification.findMany({
        where: { tenantId, status: 'ACTIVE', expiresAt: { not: null } },
        include: { employee: { select: { userId: true } } },
      });

      for (const cert of certifications) {
        const bucket = determineComplianceBucket({ status: cert.status, expiresAt: cert.expiresAt }, today);
        if (bucket === 'COMPLIANT') {
          continue;
        }

        const needsReminder = bucket !== cert.lastReminderBucket;
        await tx.certification.update({
          where: { id: cert.id },
          data: {
            status: bucket === 'EXPIRED' ? 'EXPIRED' : cert.status,
            lastReminderBucket: bucket,
            lastReminderSentAt: needsReminder ? today : cert.lastReminderSentAt,
          },
        });

        if (needsReminder && cert.employee.userId) {
          const eventType = bucket === 'EXPIRED' ? 'lms.certification_expired' : 'lms.certification_expiring';
          this.eventEmitter.emit(eventType, {
            type: eventType,
            tenantId,
            certificationId: cert.id,
            courseId: cert.courseId,
            employeeUserId: cert.employee.userId,
            expiresAt: cert.expiresAt?.toISOString() ?? null,
          });
        }
      }
    });
  }
}
