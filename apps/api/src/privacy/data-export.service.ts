import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@hrm/db';
import { withTenantContext } from '@hrm/db';
import type { DataSubjectTypeKey } from '@hrm/shared';
import { StorageService } from '../storage/storage.service';
import { PRIVACY_EXPORT_STORAGE_PREFIX } from './privacy.constants';

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export interface ExportResult {
  storageKey: string;
  fileKeys: string[];
}

/** The one shared shape every `build*Export` method returns — kept loose (`Record<string, unknown>`) since each subject type's manifest genuinely has a different set of sections. */
export type PrivacyExportManifest = Record<string, unknown>;

/**
 * Aggregates a data subject's personal data across every module that holds
 * it into ONE structured JSON manifest plus copies of any binary documents
 * that belong to them (resumes, uploaded HR documents) — the "JSON + files"
 * export format this step's brief calls for. See
 * docs/conventions/privacy-residency.md § Export.
 *
 * Deliberately reads via PLAIN `tx.<model>.findMany` calls rather than
 * routing through each owning module's own service — this is a read-only,
 * cross-cutting aggregation with no business-rule enforcement of its own
 * (unlike erasure, which must respect each category's erasure policy), the
 * same "no dedicated service to call, so read the table directly" posture
 * data-migration.md's BRANCH/DEPARTMENT/DESIGNATION/COST_CENTER importers
 * already document for themselves, applied here to a READ instead of a
 * write. Every query is already RLS-scoped by the caller's own
 * `withTenantContext` transaction — no separate tenant filter needed beyond
 * the `tenantId` column every table already carries.
 */
@Injectable()
export class DataExportService {
  private readonly logger = new Logger(DataExportService.name);

  constructor(private readonly storage: StorageService) {}

  async run(tenantId: string, requestId: string, subjectType: DataSubjectTypeKey, subjectId: string): Promise<ExportResult> {
    const manifest = await withTenantContext(tenantId, (tx): Promise<PrivacyExportManifest> => {
      if (subjectType === 'EMPLOYEE') {
        return this.buildEmployeeExport(tx, tenantId, subjectId);
      }
      if (subjectType === 'CANDIDATE') {
        return this.buildCandidateExport(tx, tenantId, subjectId);
      }
      return this.buildUserExport(tx, tenantId, subjectId);
    });

    const basePrefix = `${PRIVACY_EXPORT_STORAGE_PREFIX}/${tenantId}/${requestId}`;
    const fileKeys: string[] = [];

    // Copy any binary documents belonging to the subject into the export
    // folder alongside the JSON manifest — "JSON + files", not just a JSON
    // description of what files exist.
    const documents = (manifest as { documents?: { id: string; fileName: string; storageKey: string }[] }).documents ?? [];
    for (const doc of documents) {
      // eslint-disable-next-line no-await-in-loop -- documents are copied one at a time; export volume per data subject is small (a handful of HR documents), not a hot path
      const { body } = await this.storage.downloadObject(doc.storageKey);
      // eslint-disable-next-line no-await-in-loop
      const buffer = await streamToBuffer(body);
      const destKey = `${basePrefix}/files/${doc.id}-${doc.fileName}`;
      // eslint-disable-next-line no-await-in-loop
      await this.storage.uploadObject({ key: destKey, body: buffer, contentType: 'application/octet-stream' });
      fileKeys.push(destKey);
    }

    const manifestKey = `${basePrefix}/export.json`;
    await this.storage.uploadObject({
      key: manifestKey,
      body: Buffer.from(JSON.stringify({ ...manifest, exportedAt: new Date().toISOString(), fileKeys }, null, 2), 'utf8'),
      contentType: 'application/json',
    });

    this.logger.log(`Built data export for ${subjectType} ${subjectId} (tenant ${tenantId}): ${manifestKey}, ${fileKeys.length} file(s).`);
    return { storageKey: manifestKey, fileKeys };
  }

  private async buildEmployeeExport(tx: Prisma.TransactionClient, tenantId: string, employeeId: string): Promise<PrivacyExportManifest> {
    const employee = await tx.employee.findUnique({ where: { tenantId_id: { tenantId, id: employeeId } } });
    if (!employee) {
      throw new NotFoundException(`Employee "${employeeId}" was not found.`);
    }

    const [
      dependents,
      emergencyContacts,
      documentRows,
      customFields,
      leaveBalances,
      leaveRequests,
      attendanceRecords,
      attendanceRegularizations,
      payrollRunLines,
      payslipDocuments,
      benefitEnrollments,
      benefitContributions,
      goals,
      appraisals,
      reviewAssignments,
      expenseClaims,
      assetAssignments,
      tickets,
      lmsEnrollments,
      lmsCertifications,
      consents,
      auditEntries,
    ] = await Promise.all([
      tx.employeeDependent.findMany({ where: { tenantId, employeeId } }),
      tx.employeeEmergencyContact.findMany({ where: { tenantId, employeeId } }),
      tx.employeeDocument.findMany({ where: { tenantId, employeeId } }),
      tx.customFieldValueSet.findFirst({ where: { tenantId, entityType: 'Employee', entityId: employeeId } }),
      tx.leaveBalance.findMany({ where: { tenantId, employeeId } }),
      tx.leaveRequest.findMany({ where: { tenantId, employeeId } }),
      tx.attendanceRecord.findMany({ where: { tenantId, employeeId } }),
      tx.attendanceRegularization.findMany({ where: { tenantId, employeeId } }),
      tx.payrollRunLine.findMany({ where: { tenantId, employeeId } }),
      tx.payslipDocument.findMany({ where: { tenantId, payrollRunLine: { employeeId } } }),
      tx.benefitEnrollment.findMany({ where: { tenantId, employeeId } }),
      tx.benefitContributionRecord.findMany({ where: { tenantId, employeeId } }),
      tx.goal.findMany({ where: { tenantId, employeeId } }),
      tx.appraisal.findMany({ where: { tenantId, employeeId } }),
      tx.reviewAssignment.findMany({ where: { tenantId, reviewerId: employeeId } }),
      tx.expenseClaim.findMany({ where: { tenantId, employeeId } }),
      tx.assetAssignment.findMany({ where: { tenantId, employeeId } }),
      tx.ticket.findMany({ where: { tenantId, employeeId } }),
      tx.enrollment.findMany({ where: { tenantId, employeeId } }),
      tx.certification.findMany({ where: { tenantId, employeeId } }),
      tx.consentRecord.findMany({ where: { tenantId, subjectType: 'EMPLOYEE', subjectId: employeeId } }),
      tx.auditLog.findMany({ where: { tenantId, entityType: 'Employee', entityId: employeeId }, orderBy: { occurredAt: 'desc' }, take: 500 }),
    ]);

    return {
      subjectType: 'EMPLOYEE' as const,
      subjectId: employeeId,
      profile: employee,
      dependents,
      emergencyContacts,
      customFields: customFields?.values ?? {},
      documents: documentRows.map((d) => ({ id: d.id, fileName: d.fileName, documentType: d.documentType, storageKey: d.storageKey })),
      leave: { balances: leaveBalances, requests: leaveRequests },
      attendance: { records: attendanceRecords, regularizations: attendanceRegularizations },
      payroll: { runLines: payrollRunLines, payslips: payslipDocuments.map((p) => ({ id: p.id, payrollRunLineId: p.payrollRunLineId, language: p.language, generatedAt: p.generatedAt })) },
      benefits: { enrollments: benefitEnrollments, contributions: benefitContributions },
      performance: { goals, appraisals, reviewAssignments },
      expenseClaims,
      assetAssignments,
      helpdeskTickets: tickets,
      lms: { enrollments: lmsEnrollments, certifications: lmsCertifications },
      consents,
      auditTrail: auditEntries,
    };
  }

  private async buildCandidateExport(tx: Prisma.TransactionClient, tenantId: string, candidateId: string): Promise<PrivacyExportManifest> {
    const candidate = await tx.candidate.findUnique({ where: { tenantId_id: { tenantId, id: candidateId } } });
    if (!candidate) {
      throw new NotFoundException(`Candidate "${candidateId}" was not found.`);
    }

    const [applications, interviews, scorecards, offers, onboardingProcess, consents, auditEntries] = await Promise.all([
      tx.application.findMany({ where: { tenantId, candidateId } }),
      tx.interview.findMany({ where: { tenantId, application: { candidateId } } }),
      tx.interviewScorecard.findMany({ where: { tenantId, interview: { application: { candidateId } } } }),
      tx.offer.findMany({ where: { tenantId, application: { candidateId } } }),
      tx.onboardingProcess.findFirst({ where: { tenantId, candidateId } }),
      tx.consentRecord.findMany({ where: { tenantId, subjectType: 'CANDIDATE', subjectId: candidateId } }),
      tx.auditLog.findMany({
        where: { tenantId, OR: [{ entityType: 'Candidate', entityId: candidateId }, { entityType: 'Application', entityId: { in: (await tx.application.findMany({ where: { tenantId, candidateId }, select: { id: true } })).map((a) => a.id) } }] },
        orderBy: { occurredAt: 'desc' },
        take: 500,
      }),
    ]);

    return {
      subjectType: 'CANDIDATE' as const,
      subjectId: candidateId,
      profile: candidate,
      documents: candidate.resumeStorageKey ? [{ id: candidateId, fileName: 'resume', documentType: 'RESUME', storageKey: candidate.resumeStorageKey }] : [],
      applications,
      interviews,
      interviewScorecards: scorecards,
      offers,
      onboardingProcess,
      consents,
      auditTrail: auditEntries,
    };
  }

  private async buildUserExport(tx: Prisma.TransactionClient, tenantId: string, userId: string): Promise<PrivacyExportManifest> {
    const user = await tx.user.findUnique({ where: { tenantId_id: { tenantId, id: userId } } });
    if (!user) {
      throw new NotFoundException(`User "${userId}" was not found.`);
    }

    const [consents, auditEntries] = await Promise.all([
      tx.consentRecord.findMany({ where: { tenantId, subjectType: 'USER', subjectId: userId } }),
      tx.auditLog.findMany({ where: { tenantId, actorUserId: userId }, orderBy: { occurredAt: 'desc' }, take: 500 }),
    ]);

    return {
      subjectType: 'USER' as const,
      subjectId: userId,
      profile: { id: user.id, email: user.email, status: user.status, createdAt: user.createdAt },
      documents: [],
      consents,
      auditTrail: auditEntries,
    };
  }
}
