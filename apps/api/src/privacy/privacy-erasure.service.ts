import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { prisma, withTenantContext } from '@hrm/db';
import type { DataSubjectTypeKey } from '@hrm/shared';
import { TokenService } from '../auth/token.service';
import { StorageService } from '../storage/storage.service';

export type ErasureSummary = Record<string, { action: 'HARD_DELETE' | 'ANONYMIZE' | 'RETAIN_LEGAL'; note: string; count?: number }>;

const PLACEHOLDER_FIRST_NAME = 'Erased';
const PLACEHOLDER_LAST_NAME = 'Data Subject';

/**
 * THE erasure/anonymization engine — see docs/conventions/privacy-residency.md
 * for the full per-`DataCategory` policy table this reconciles against the
 * immutable `audit_log`/legally-retained payroll trail. Called BOTH by
 * `PrivacyProcessor` (an on-demand, approved `ERASURE` `DataSubjectRequest`)
 * AND by `RetentionEnforcementService` (the scheduled past-window auto-purge)
 * — ONE engine, two callers, so the two paths can never drift.
 *
 * Deliberately bypasses `EmployeeService`/`CandidateService` and writes
 * directly via `tx`/the owner `prisma` client — erasure has fundamentally
 * different semantics from an ordinary create/update (it WANTS to null out
 * fields a normal update would enforce as required), the same "no dedicated
 * service fits, write directly" posture data-migration.md's reference-table
 * importers already document for themselves.
 */
@Injectable()
export class PrivacyErasureService {
  private readonly logger = new Logger(PrivacyErasureService.name);

  constructor(
    private readonly storage: StorageService,
    private readonly tokens: TokenService,
  ) {}

  async run(tenantId: string, subjectType: DataSubjectTypeKey, subjectId: string): Promise<ErasureSummary> {
    if (subjectType === 'EMPLOYEE') {
      return this.eraseEmployee(tenantId, subjectId);
    }
    if (subjectType === 'CANDIDATE') {
      return this.eraseCandidate(tenantId, subjectId);
    }
    return this.eraseUser(tenantId, subjectId);
  }

  private async eraseEmployee(tenantId: string, employeeId: string): Promise<ErasureSummary> {
    const documents = await withTenantContext(tenantId, async (tx) => {
      const employee = await tx.employee.findUnique({ where: { tenantId_id: { tenantId, id: employeeId } } });
      if (!employee) {
        throw new NotFoundException(`Employee "${employeeId}" was not found.`);
      }
      if (employee.status !== 'TERMINATED') {
        throw new ConflictException('An employee must be offboarded (status TERMINATED) before their profile can be erased.');
      }

      const piiValues = [employee.firstName, employee.lastName, employee.personalEmail, employee.phone].filter(
        (v): v is string => typeof v === 'string' && v.length > 0,
      );

      const docs = await tx.employeeDocument.findMany({ where: { tenantId, employeeId } });

      await tx.employee.update({
        where: { tenantId_id: { tenantId, id: employeeId } },
        data: {
          firstName: PLACEHOLDER_FIRST_NAME,
          lastName: PLACEHOLDER_LAST_NAME,
          personalEmail: null,
          phone: null,
          dateOfBirth: null,
          gender: null,
          statutoryFields: {},
          bankAccountNumberEncrypted: null,
          bankNameEncrypted: null,
          bankRoutingCodeEncrypted: null,
          baseSalaryEncrypted: null,
        },
      });
      await tx.employeeDependent.deleteMany({ where: { tenantId, employeeId } });
      await tx.employeeEmergencyContact.deleteMany({ where: { tenantId, employeeId } });
      await tx.employeeDocument.deleteMany({ where: { tenantId, employeeId } });
      await tx.customFieldValueSet.deleteMany({ where: { tenantId, entityType: 'Employee', entityId: employeeId } });

      if (employee.userId) {
        const placeholderEmail = `erased-${employeeId}@erased.invalid`;
        piiValues.push(employee.userId);
        await tx.user.update({
          where: { tenantId_id: { tenantId, id: employee.userId } },
          data: { email: placeholderEmail, status: 'DISABLED', pushToken: null },
        });
      }

      return { docs, piiValues, userId: employee.userId };
    });

    if (documents.userId) {
      await this.tokens.revokeAllForUser(tenantId, documents.userId);
    }
    for (const doc of documents.docs) {
      // eslint-disable-next-line no-await-in-loop -- a handful of documents per employee, not a hot path
      await this.storage.deleteObject(doc.storageKey).catch((error) => {
        this.logger.warn(`Failed to delete document object "${doc.storageKey}" during erasure: ${String(error)}`);
      });
    }

    const auditRowsUpdated = await this.anonymizeAuditTrail(tenantId, 'Employee', employeeId, documents.piiValues);

    const summary: ErasureSummary = {
      EMPLOYEE_PROFILE: { action: 'ANONYMIZE', note: 'Name/contact/DOB/gender/bank/statutory identifiers scrubbed; employeeCode, branch, and dates retained for downstream payroll/analytics integrity.' },
      DOCUMENTS: { action: 'HARD_DELETE', note: 'Uploaded document metadata and object-storage bytes removed.', count: documents.docs.length },
      PAYROLL_TAX_RECORDS: { action: 'RETAIN_LEGAL', note: 'PayrollRunLine/PayslipDocument carry no direct PII of their own (amounts plus this now-anonymized Employee reference only) — retained intact for statutory record-keeping.' },
      AUDIT_TRAIL: { action: 'ANONYMIZE', note: 'PII values scrubbed within existing audit_log rows referencing this employee; no row was deleted (DB-level immutability preserved).', count: auditRowsUpdated },
    };
    this.logger.log(`Erased Employee ${employeeId} (tenant ${tenantId}): ${JSON.stringify(summary)}`);
    return summary;
  }

  private async eraseCandidate(tenantId: string, candidateId: string): Promise<ErasureSummary> {
    const { candidate, applicationIds, piiValues } = await withTenantContext(tenantId, async (tx) => {
      const found = await tx.candidate.findUnique({
        where: { tenantId_id: { tenantId, id: candidateId } },
        include: { onboardingProcesses: true },
      });
      if (!found) {
        throw new NotFoundException(`Candidate "${candidateId}" was not found.`);
      }
      if (found.onboardingProcesses.some((p) => p.employeeId)) {
        throw new ConflictException('This candidate has already become an employee — erase their data via the EMPLOYEE subject type instead.');
      }
      const applications = await tx.application.findMany({ where: { tenantId, candidateId }, select: { id: true } });
      const values = [found.firstName, found.lastName, found.email, found.phone].filter((v): v is string => typeof v === 'string' && v.length > 0);
      return { candidate: found, applicationIds: applications.map((a) => a.id), piiValues: values };
    });

    if (candidate.resumeStorageKey) {
      await this.storage.deleteObject(candidate.resumeStorageKey).catch((error) => {
        this.logger.warn(`Failed to delete resume object "${candidate.resumeStorageKey}" during erasure: ${String(error)}`);
      });
    }

    let auditRowsUpdated = await this.anonymizeAuditTrail(tenantId, 'Candidate', candidateId, piiValues);
    for (const applicationId of applicationIds) {
      // eslint-disable-next-line no-await-in-loop -- a handful of applications per candidate
      auditRowsUpdated += await this.anonymizeAuditTrail(tenantId, 'Application', applicationId, piiValues);
    }

    await withTenantContext(tenantId, (tx) => tx.candidate.delete({ where: { tenantId_id: { tenantId, id: candidateId } } }));

    const summary: ErasureSummary = {
      CANDIDATE_RECORDS: { action: 'HARD_DELETE', note: 'Candidate row and its entire ATS trail (applications, interviews, scorecards, offers) removed via cascade.' },
      DOCUMENTS: { action: 'HARD_DELETE', note: candidate.resumeStorageKey ? 'Resume object removed from storage.' : 'No resume on file.' },
      AUDIT_TRAIL: { action: 'ANONYMIZE', note: 'PII values scrubbed within existing audit_log rows referencing this candidate/its applications; no row was deleted.', count: auditRowsUpdated },
    };
    this.logger.log(`Erased Candidate ${candidateId} (tenant ${tenantId}): ${JSON.stringify(summary)}`);
    return summary;
  }

  private async eraseUser(tenantId: string, userId: string): Promise<ErasureSummary> {
    const { email } = await withTenantContext(tenantId, async (tx) => {
      const user = await tx.user.findUnique({ where: { tenantId_id: { tenantId, id: userId } } });
      if (!user) {
        throw new NotFoundException(`User "${userId}" was not found.`);
      }
      const existingEmployee = await tx.employee.findFirst({ where: { tenantId, userId } });
      if (existingEmployee) {
        throw new ConflictException('This user has a linked Employee record — erase via the EMPLOYEE subject type instead.');
      }
      const previousEmail = user.email;
      await tx.user.update({
        where: { tenantId_id: { tenantId, id: userId } },
        data: { email: `erased-${userId}@erased.invalid`, status: 'DISABLED', pushToken: null },
      });
      return { email: previousEmail };
    });

    await this.tokens.revokeAllForUser(tenantId, userId);
    const auditRowsUpdated = await this.anonymizeAuditTrail(tenantId, 'User', userId, [email], userId);

    const summary: ErasureSummary = {
      AUDIT_TRAIL: { action: 'ANONYMIZE', note: 'Email scrubbed within existing audit_log rows for this user; no row was deleted.', count: auditRowsUpdated },
    };
    this.logger.log(`Erased User ${userId} (tenant ${tenantId}): ${JSON.stringify(summary)}`);
    return summary;
  }

  /**
   * ANONYMIZE-WITHIN, never row-deleted — the reconciliation this whole
   * module exists for: `audit_log` is DB-level immutable (`hrm_app` has
   * UPDATE/DELETE revoked, see docs/conventions/audit-custom-fields.md), so
   * this is the ONE deliberate, narrow exception that goes through the
   * OWNER `prisma` client instead — the exact same "infra/maintenance
   * operation, not a tenant-scoped one" reasoning
   * `PartitionMaintenanceService`/`PartitionArchivalService` already use for
   * their own owner-client-only DDL. Every write is still explicitly scoped
   * by `tenant_id` (defense-in-depth, since the owner client itself bypasses
   * RLS) and touches ONLY the JSON `before`/`after`/`metadata` payloads of
   * rows already naming this exact entity — never `entityId`/`action`/
   * `occurredAt`/`actorUserId`, and never a DELETE.
   */
  private async anonymizeAuditTrail(
    tenantId: string,
    entityType: string,
    entityId: string,
    piiValues: string[],
    actorUserId?: string,
  ): Promise<number> {
    const values = piiValues.filter((v) => v.length > 0);
    if (values.length === 0) {
      return 0;
    }

    const rows = await prisma.auditLog.findMany({
      where: {
        tenantId,
        ...(actorUserId ? { actorUserId } : { entityType, entityId }),
      },
      select: { id: true, occurredAt: true, before: true, after: true, metadata: true },
    });

    let updated = 0;
    for (const row of rows) {
      const scrubbedBefore = scrubJsonValue(row.before, values);
      const scrubbedAfter = scrubJsonValue(row.after, values);
      const scrubbedMetadata = scrubJsonValue(row.metadata, values, { subjectErased: true });
      if (scrubbedBefore.changed || scrubbedAfter.changed || scrubbedMetadata.changed) {
        // eslint-disable-next-line no-await-in-loop -- bounded by one subject's own audit history, not a hot path
        await prisma.auditLog.update({
          where: { id_occurredAt: { id: row.id, occurredAt: row.occurredAt } },
          data: {
            before: scrubbedBefore.value as never,
            after: scrubbedAfter.value as never,
            metadata: scrubbedMetadata.value as never,
          },
        });
        updated += 1;
      }
    }
    return updated;
  }
}

const REDACTION_MARK = '[ERASED]';

/** Deep-walks a JSON value, replacing any STRING that exactly equals one of `piiValues` with a fixed redaction marker. Structure/keys are otherwise untouched — only the identifying VALUES are scrubbed. */
function scrubJsonValue(
  value: unknown,
  piiValues: string[],
  extraMerge?: Record<string, unknown>,
): { value: unknown; changed: boolean } {
  let changed = false;

  function walk(node: unknown): unknown {
    if (typeof node === 'string') {
      if (piiValues.includes(node)) {
        changed = true;
        return REDACTION_MARK;
      }
      return node;
    }
    if (Array.isArray(node)) {
      return node.map(walk);
    }
    if (node && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(node as Record<string, unknown>)) {
        out[key] = walk(val);
      }
      return out;
    }
    return node;
  }

  const walked = walk(value);
  if (extraMerge && walked && typeof walked === 'object' && !Array.isArray(walked)) {
    changed = true;
    return { value: { ...(walked as Record<string, unknown>), ...extraMerge }, changed };
  }
  if (extraMerge && (walked === null || walked === undefined)) {
    changed = true;
    return { value: { ...extraMerge }, changed };
  }
  return { value: walked, changed };
}
