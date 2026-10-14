import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, Res, StreamableFile, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import {
  applyToPostingSchema,
  ApplyToPostingInput,
  PERMISSIONS,
  rankedApplicationsQuerySchema,
  RankedApplicationsQuery,
  updateParsedResumeSchema,
  UpdateParsedResumeInput,
  upsertScreeningCriteriaSchema,
  UpsertScreeningCriteriaInput,
} from '@hrm/shared';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { RequirePermissions } from '../../auth/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../../auth/guards/permissions.guard';
import { AuditLog } from '../../audit/audit-log.decorator';
import { AuditInterceptor } from '../../audit/audit.interceptor';
import { AuditCaptureService } from '../../audit/audit-capture.service';
import { TenantContextService } from '../../tenancy/tenant-context.service';
import { CandidateService } from '../candidates/candidate.service';
import { CandidateIntakeService } from '../candidates/candidate-intake.service';
import { JobPostingService } from '../postings/job-posting.service';
import { JobRequisitionService } from '../requisitions/job-requisition.service';
import { ResumeParsingService } from '../resume-parsing/resume-parsing.service';
import { ScreeningService } from './screening.service';

const MAX_RESUME_SIZE_BYTES = 10 * 1024 * 1024;

function requireTenantId(tenantId: string | null): string {
  if (!tenantId) {
    throw new BadRequestException('No tenant context is bound to this request.');
  }
  return tenantId;
}

/**
 * Resume parsing + screening — the recruiter-facing HTTP surface, step 9.1
 * (docs/conventions/resume-parsing-screening.md). Mounted under the SAME
 * `recruitment` prefix and gated by the SAME existing `recruitment.*`
 * permissions as the rest of the ATS (no new permission): reading
 * parsed data / scores / the ranked list needs `recruitment.read`; editing
 * parsed data, uploading/re-parsing a resume, adding an applicant and defining
 * criteria need `recruitment.write`. There is deliberately NO route here that
 * changes an application's stage — advancing/rejecting stays the existing,
 * human-driven `PATCH /recruitment/applications/:id/stage`.
 */
@Controller('recruitment')
export class ScreeningController {
  constructor(
    private readonly screening: ScreeningService,
    private readonly resumeParsing: ResumeParsingService,
    private readonly candidates: CandidateService,
    private readonly intake: CandidateIntakeService,
    private readonly postings: JobPostingService,
    private readonly requisitions: JobRequisitionService,
    private readonly tenantContext: TenantContextService,
    private readonly auditCapture: AuditCaptureService,
  ) {}

  // --- Screening criteria (config data, per requisition) -----------------------

  @Get('requisitions/:id/screening-criteria')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.RECRUITMENT_READ)
  async getCriteria(@Param('id') id: string) {
    return this.screening.getCriteria(this.tenantContext.getTx(), id, this.tenantContext.getBranchIds());
  }

  @Put('requisitions/:id/screening-criteria')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.RECRUITMENT_WRITE)
  @AuditLog('ScreeningCriteria', 'UPSERT')
  async upsertCriteria(@Param('id') id: string, @Body(new ZodValidationPipe(upsertScreeningCriteriaSchema)) body: UpsertScreeningCriteriaInput) {
    const tx = this.tenantContext.getTx();
    this.auditCapture.setBefore(await this.screening.getCriteria(tx, id, this.tenantContext.getBranchIds()));
    return this.screening.upsertCriteria(tx, requireTenantId(this.tenantContext.tenantId), this.tenantContext.userId!, id, this.tenantContext.getBranchIds(), body);
  }

  @Delete('requisitions/:id/screening-criteria')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.RECRUITMENT_WRITE)
  @AuditLog('ScreeningCriteria', 'DELETE')
  async deleteCriteria(@Param('id') id: string) {
    const tx = this.tenantContext.getTx();
    this.auditCapture.setBefore(await this.screening.getCriteria(tx, id, this.tenantContext.getBranchIds()));
    return this.screening.deleteCriteria(tx, requireTenantId(this.tenantContext.tenantId), id, this.tenantContext.getBranchIds());
  }

  // --- Ranked applicant list -------------------------------------------------------

  @Get('requisitions/:id/ranked-applications')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.RECRUITMENT_READ)
  async ranked(@Param('id') id: string, @Query(new ZodValidationPipe(rankedApplicationsQuerySchema)) query: RankedApplicationsQuery) {
    return this.screening.ranked(this.tenantContext.getTx(), id, this.tenantContext.getBranchIds(), query);
  }

  @Get('applications/:id/screening')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.RECRUITMENT_READ)
  async applicationScreening(@Param('id') id: string) {
    return this.screening.getApplicationScreening(this.tenantContext.getTx(), id, this.tenantContext.getBranchIds());
  }

  // --- Recruiter-side intake ---------------------------------------------------------

  /** A recruiter adds an applicant (with an optional resume) to a posting — the internal twin of the public careers apply route. */
  @Post('postings/:id/applicants')
  @UseInterceptors(PermissionsGuard, AuditInterceptor, FileInterceptor('resume', { limits: { fileSize: MAX_RESUME_SIZE_BYTES } }))
  @RequirePermissions(PERMISSIONS.RECRUITMENT_WRITE)
  @AuditLog('Application', 'RECRUITER_ADD')
  async addApplicant(
    @Param('id') id: string,
    @UploadedFile() resume: Express.Multer.File | undefined,
    @Body(new ZodValidationPipe(applyToPostingSchema)) body: ApplyToPostingInput,
  ) {
    const tx = this.tenantContext.getTx();
    const posting = await this.postings.findById(tx, id);
    await this.requisitions.findById(tx, posting.requisitionId, this.tenantContext.getBranchIds());
    const { screeningResult: _r, ...application } = await this.intake.intake(
      tx,
      requireTenantId(this.tenantContext.tenantId),
      posting,
      body,
      'recruiter_added',
      resume ? { buffer: resume.buffer, originalname: resume.originalname, mimetype: resume.mimetype } : undefined,
    );
    return application;
  }

  // --- Resume + parsed data (per candidate) ---------------------------------------------

  @Post('candidates/:id/resume')
  @UseInterceptors(PermissionsGuard, AuditInterceptor, FileInterceptor('resume', { limits: { fileSize: MAX_RESUME_SIZE_BYTES } }))
  @RequirePermissions(PERMISSIONS.RECRUITMENT_WRITE)
  @AuditLog('Candidate', 'UPLOAD_RESUME')
  async uploadResume(@Param('id') id: string, @UploadedFile() resume: Express.Multer.File | undefined) {
    if (!resume) {
      throw new BadRequestException('A "resume" file is required.');
    }
    const tx = this.tenantContext.getTx();
    await this.candidates.findById(tx, id);
    await this.resumeParsing.storeAndEnqueue(tx, requireTenantId(this.tenantContext.tenantId), id, {
      buffer: resume.buffer,
      originalname: resume.originalname,
      mimetype: resume.mimetype,
    });
    return { candidateId: id, parseStatus: 'PENDING' };
  }

  @Get('candidates/:id/resume')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.RECRUITMENT_READ)
  async downloadResume(@Param('id') id: string, @Res({ passthrough: true }) res: Response) {
    const { body, contentType, fileName } = await this.resumeParsing.downloadResume(this.tenantContext.getTx(), id);
    res.set({
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename="${fileName.replace(/[^\w.\- ]+/g, '_')}"`,
    });
    return new StreamableFile(body);
  }

  @Post('candidates/:id/reparse')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.RECRUITMENT_WRITE)
  @AuditLog('Candidate', 'REPARSE_RESUME')
  async reparse(@Param('id') id: string) {
    await this.resumeParsing.reparse(this.tenantContext.getTx(), requireTenantId(this.tenantContext.tenantId), id);
    return { candidateId: id, parseStatus: 'PENDING' };
  }

  @Patch('candidates/:id/parsed-resume')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.RECRUITMENT_WRITE)
  @AuditLog('Candidate', 'EDIT_PARSED_RESUME')
  async editParsed(@Param('id') id: string, @Body(new ZodValidationPipe(updateParsedResumeSchema)) body: UpdateParsedResumeInput) {
    const tx = this.tenantContext.getTx();
    const before = await this.candidates.findById(tx, id);
    this.auditCapture.setBefore({ parseStatus: before.parseStatus, parsedData: before.parsedData });
    return this.resumeParsing.updateParsedData(tx, id, this.tenantContext.userId!, body);
  }
}
