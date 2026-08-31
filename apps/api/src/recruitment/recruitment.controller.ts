import { BadRequestException, Body, Controller, Get, Param, Patch, Post, Query, UseInterceptors } from '@nestjs/common';
import {
  createInterviewSchema,
  CreateInterviewInput,
  createJobPostingSchema,
  CreateJobPostingInput,
  createJobRequisitionSchema,
  CreateJobRequisitionInput,
  createOfferSchema,
  CreateOfferInput,
  PERMISSIONS,
  submitScorecardSchema,
  SubmitScorecardInput,
  updateApplicationStageSchema,
  UpdateApplicationStageInput,
} from '@hrm/shared';
import type { Interview, Offer } from '@hrm/db';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { AuditLog } from '../audit/audit-log.decorator';
import { AuditInterceptor } from '../audit/audit.interceptor';
import { AuditCaptureService } from '../audit/audit-capture.service';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { JobRequisitionService } from './requisitions/job-requisition.service';
import { JobPostingService } from './postings/job-posting.service';
import { CandidateService } from './candidates/candidate.service';
import { ApplicationService } from './applications/application.service';
import { InterviewService } from './interviews/interview.service';
import { OfferService } from './offers/offer.service';

function requireTenantId(tenantId: string | null): string {
  if (!tenantId) {
    throw new BadRequestException('No tenant context is bound to this request.');
  }
  return tenantId;
}

/**
 * The Recruitment (ATS) module's INTERNAL HTTP surface — see
 * docs/conventions/recruitment-lifecycle.md. Deliberately no
 * approve/reject route for requisitions or offers — THE RULE
 * (docs/conventions/workflow.md): act via the generic
 * `POST /workflow/instances/:id/steps/:stepId/actions`, keyed off the
 * `workflowInstanceId` returned on the requisition/offer's own `GET`.
 */
@Controller('recruitment')
export class RecruitmentController {
  constructor(
    private readonly requisitions: JobRequisitionService,
    private readonly postings: JobPostingService,
    private readonly candidates: CandidateService,
    private readonly applications: ApplicationService,
    private readonly interviews: InterviewService,
    private readonly offers: OfferService,
    private readonly tenantContext: TenantContextService,
    private readonly auditCapture: AuditCaptureService,
  ) {}

  // --- Requisitions ---------------------------------------------------

  @Post('requisitions')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.RECRUITMENT_WRITE)
  @AuditLog('JobRequisition', 'CREATE')
  async createRequisition(@Body(new ZodValidationPipe(createJobRequisitionSchema)) body: CreateJobRequisitionInput) {
    return this.requisitions.create(this.tenantContext.getTx(), requireTenantId(this.tenantContext.tenantId), this.tenantContext.userId!, this.tenantContext.getBranchIds(), body);
  }

  @Post('requisitions/:id/submit-for-approval')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.RECRUITMENT_MANAGE)
  @AuditLog('JobRequisition', 'SUBMIT_FOR_APPROVAL')
  async submitRequisition(@Param('id') id: string) {
    const tx = this.tenantContext.getTx();
    const requisition = await this.requisitions.findById(tx, id, this.tenantContext.getBranchIds());
    await this.requisitions.submitForApproval(tx, requireTenantId(this.tenantContext.tenantId), this.tenantContext.userId!, requisition.id);
    return { submitted: true };
  }

  @Post('requisitions/:id/close')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.RECRUITMENT_MANAGE)
  @AuditLog('JobRequisition', 'CLOSE')
  async closeRequisition(@Param('id') id: string) {
    const tx = this.tenantContext.getTx();
    await this.requisitions.findById(tx, id, this.tenantContext.getBranchIds());
    return this.requisitions.close(tx, id);
  }

  @Get('requisitions')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.RECRUITMENT_READ)
  async listRequisitions(@Query('status') status?: string, @Query('branchId') branchId?: string) {
    return this.requisitions.list(this.tenantContext.getTx(), this.tenantContext.getBranchIds(), { status, branchId });
  }

  @Get('requisitions/:id')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.RECRUITMENT_READ)
  async getRequisition(@Param('id') id: string) {
    return this.requisitions.findById(this.tenantContext.getTx(), id, this.tenantContext.getBranchIds());
  }

  // --- Postings ---------------------------------------------------------

  @Post('postings')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.RECRUITMENT_MANAGE)
  @AuditLog('JobPosting', 'CREATE')
  async createPosting(@Body(new ZodValidationPipe(createJobPostingSchema)) body: CreateJobPostingInput) {
    return this.postings.create(this.tenantContext.getTx(), requireTenantId(this.tenantContext.tenantId), body);
  }

  @Post('postings/:id/publish')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.RECRUITMENT_MANAGE)
  @AuditLog('JobPosting', 'PUBLISH')
  async publishPosting(@Param('id') id: string) {
    return this.postings.publish(this.tenantContext.getTx(), id);
  }

  @Post('postings/:id/close')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.RECRUITMENT_MANAGE)
  @AuditLog('JobPosting', 'CLOSE')
  async closePosting(@Param('id') id: string) {
    return this.postings.close(this.tenantContext.getTx(), id);
  }

  @Get('postings')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.RECRUITMENT_READ)
  async listPostings(@Query('status') status?: string) {
    return this.postings.list(this.tenantContext.getTx(), status);
  }

  @Get('postings/:id')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.RECRUITMENT_READ)
  async getPosting(@Param('id') id: string) {
    return this.postings.findById(this.tenantContext.getTx(), id);
  }

  // --- Candidates + Applications -----------------------------------------

  @Get('candidates')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.RECRUITMENT_READ)
  async listCandidates() {
    return this.candidates.list(this.tenantContext.getTx());
  }

  @Get('candidates/:id')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.RECRUITMENT_READ)
  async getCandidate(@Param('id') id: string) {
    return this.candidates.findById(this.tenantContext.getTx(), id);
  }

  @Get('applications')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.RECRUITMENT_READ)
  async listApplications(@Query('jobPostingId') jobPostingId?: string, @Query('candidateId') candidateId?: string, @Query('stage') stage?: string) {
    return this.applications.list(this.tenantContext.getTx(), { jobPostingId, candidateId, stage });
  }

  @Get('applications/:id')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.RECRUITMENT_READ)
  async getApplication(@Param('id') id: string) {
    return this.applications.findById(this.tenantContext.getTx(), id);
  }

  @Patch('applications/:id/stage')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.RECRUITMENT_WRITE)
  @AuditLog('Application', 'STAGE_CHANGE')
  async updateApplicationStage(@Param('id') id: string, @Body(new ZodValidationPipe(updateApplicationStageSchema)) body: UpdateApplicationStageInput) {
    const tx = this.tenantContext.getTx();
    const before = await this.applications.findById(tx, id);
    this.auditCapture.setBefore(before);
    return this.applications.updateStage(tx, id, body.stage);
  }

  // --- Interviews ---------------------------------------------------------

  @Post('interviews')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.RECRUITMENT_WRITE)
  @AuditLog('Interview', 'CREATE')
  async scheduleInterview(@Body(new ZodValidationPipe(createInterviewSchema)) body: CreateInterviewInput): Promise<Interview> {
    return this.interviews.schedule(this.tenantContext.getTx(), requireTenantId(this.tenantContext.tenantId), body);
  }

  @Get('applications/:applicationId/interviews')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.RECRUITMENT_READ)
  async listInterviews(@Param('applicationId') applicationId: string): Promise<Interview[]> {
    return this.interviews.listForApplication(this.tenantContext.getTx(), applicationId);
  }

  @Get('interviews/:id')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.RECRUITMENT_READ)
  async getInterview(@Param('id') id: string): Promise<Interview> {
    return this.interviews.findById(this.tenantContext.getTx(), id);
  }

  @Post('interviews/:id/scorecards')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.RECRUITMENT_WRITE)
  @AuditLog('InterviewScorecard', 'CREATE')
  async submitScorecard(@Param('id') id: string, @Body(new ZodValidationPipe(submitScorecardSchema)) body: SubmitScorecardInput) {
    const canManage = this.tenantContext.hasPermission(PERMISSIONS.RECRUITMENT_MANAGE);
    return this.interviews.submitScorecard(this.tenantContext.getTx(), requireTenantId(this.tenantContext.tenantId), id, this.tenantContext.userId!, canManage, body);
  }

  @Get('interviews/:id/scorecards')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.RECRUITMENT_READ)
  async listScorecards(@Param('id') id: string) {
    return this.interviews.listScorecards(this.tenantContext.getTx(), id);
  }

  // --- Offers ---------------------------------------------------------

  @Post('offers')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.RECRUITMENT_WRITE)
  @AuditLog('Offer', 'CREATE')
  async createOffer(@Body(new ZodValidationPipe(createOfferSchema)) body: CreateOfferInput): Promise<Offer> {
    return this.offers.create(this.tenantContext.getTx(), requireTenantId(this.tenantContext.tenantId), this.tenantContext.userId!, body);
  }

  @Post('offers/:id/submit-for-approval')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.RECRUITMENT_MANAGE)
  @AuditLog('Offer', 'SUBMIT_FOR_APPROVAL')
  async submitOffer(@Param('id') id: string) {
    await this.offers.submitForApproval(this.tenantContext.getTx(), requireTenantId(this.tenantContext.tenantId), this.tenantContext.userId!, id);
    return { submitted: true };
  }

  @Post('offers/:id/accept')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.RECRUITMENT_MANAGE)
  @AuditLog('Offer', 'ACCEPT')
  async acceptOffer(@Param('id') id: string): Promise<Offer> {
    return this.offers.accept(this.tenantContext.getTx(), requireTenantId(this.tenantContext.tenantId), id);
  }

  @Post('offers/:id/decline')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.RECRUITMENT_MANAGE)
  @AuditLog('Offer', 'DECLINE')
  async declineOffer(@Param('id') id: string): Promise<Offer> {
    return this.offers.decline(this.tenantContext.getTx(), id);
  }

  @Get('offers')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.RECRUITMENT_READ)
  async listOffers(@Query('applicationId') applicationId?: string): Promise<Offer[]> {
    return this.offers.list(this.tenantContext.getTx(), applicationId);
  }

  @Get('offers/:id')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.RECRUITMENT_READ)
  async getOffer(@Param('id') id: string): Promise<Offer> {
    return this.offers.findById(this.tenantContext.getTx(), id);
  }
}
