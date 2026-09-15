import { BadRequestException, Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Put, Query, Res, StreamableFile, UseInterceptors } from '@nestjs/common';
import type { Response } from 'express';
import type { ConsentRecord, DataSubjectRequest } from '@hrm/db';
import {
  AUDIT_ACTIONS,
  createDataSubjectRequestSchema,
  CreateDataSubjectRequestInput,
  dataCategorySchema,
  listConsentRecordsQuerySchema,
  ListConsentRecordsQuery,
  listDataSubjectRequestsQuerySchema,
  ListDataSubjectRequestsQuery,
  PERMISSIONS,
  recordConsentRequestSchema,
  RecordConsentInput,
  upsertTenantDataRetentionOverrideRequestSchema,
  UpsertTenantDataRetentionOverrideInput,
} from '@hrm/shared';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { AuditLog } from '../audit/audit-log.decorator';
import { AuditInterceptor } from '../audit/audit.interceptor';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { DATA_SUBJECT_REQUEST_ENTITY_TYPE, CONSENT_RECORD_ENTITY_TYPE } from './privacy.constants';
import { DataSubjectRequestService } from './data-subject-request.service';
import { ConsentService } from './consent.service';
import { ProcessingRegisterService } from './processing-register.service';

function requireTenantId(tenantId: string | null): string {
  if (!tenantId) {
    throw new BadRequestException('No tenant context is bound to this request.');
  }
  return tenantId;
}

/**
 * Tenant admin surface for data-subject rights (step 6.1) — see
 * docs/conventions/privacy-residency.md. Every mutating route is
 * deny-by-default (`privacy.manage`, TENANT_ADMIN only). Requesting an
 * export/erasure enqueues async work (`DataSubjectRequestService.submit`);
 * the caller polls `GET /privacy/requests/:id`, the SAME "submit -> poll"
 * shape the migration toolkit already establishes.
 */
@Controller('privacy')
export class PrivacyController {
  constructor(
    private readonly requests: DataSubjectRequestService,
    private readonly consents: ConsentService,
    private readonly register: ProcessingRegisterService,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Post('requests')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.PRIVACY_MANAGE)
  @AuditLog(DATA_SUBJECT_REQUEST_ENTITY_TYPE, AUDIT_ACTIONS.CREATE)
  createRequest(@Body(new ZodValidationPipe(createDataSubjectRequestSchema)) body: CreateDataSubjectRequestInput): Promise<DataSubjectRequest> {
    const tenantId = requireTenantId(this.tenantContext.tenantId);
    return this.requests.submit(this.tenantContext.getTx(), tenantId, body, { userId: this.tenantContext.userId });
  }

  @Get('requests')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.PRIVACY_MANAGE)
  listRequests(@Query(new ZodValidationPipe(listDataSubjectRequestsQuerySchema)) query: ListDataSubjectRequestsQuery): Promise<DataSubjectRequest[]> {
    const tenantId = requireTenantId(this.tenantContext.tenantId);
    return this.requests.list(this.tenantContext.getTx(), tenantId, query);
  }

  @Get('requests/:id')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.PRIVACY_MANAGE)
  getRequest(@Param('id') id: string): Promise<DataSubjectRequest> {
    const tenantId = requireTenantId(this.tenantContext.tenantId);
    return this.requests.get(this.tenantContext.getTx(), tenantId, id);
  }

  @Get('requests/:id/export')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.PRIVACY_MANAGE)
  async downloadExport(@Param('id') id: string, @Res({ passthrough: true }) res: Response): Promise<StreamableFile> {
    const tenantId = requireTenantId(this.tenantContext.tenantId);
    const { storageKey } = await this.requests.getExportManifest(this.tenantContext.getTx(), tenantId, id);
    const { body, contentType } = await this.requests.downloadExportManifest(storageKey);
    res.set({ 'Content-Type': contentType ?? 'application/json', 'Content-Disposition': 'attachment; filename="export.json"' });
    return new StreamableFile(body);
  }

  @Post('consents')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.PRIVACY_MANAGE)
  @AuditLog(CONSENT_RECORD_ENTITY_TYPE, AUDIT_ACTIONS.CREATE)
  recordConsent(@Body(new ZodValidationPipe(recordConsentRequestSchema)) body: RecordConsentInput): Promise<ConsentRecord> {
    const tenantId = requireTenantId(this.tenantContext.tenantId);
    return this.consents.record(this.tenantContext.getTx(), tenantId, this.tenantContext.userId, body);
  }

  @Get('consents')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.PRIVACY_MANAGE)
  listConsents(@Query(new ZodValidationPipe(listConsentRecordsQuerySchema)) query: ListConsentRecordsQuery): Promise<ConsentRecord[]> {
    const tenantId = requireTenantId(this.tenantContext.tenantId);
    return this.consents.list(this.tenantContext.getTx(), tenantId, query);
  }

  @Get('register')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.PRIVACY_MANAGE)
  listRegister() {
    return this.register.listRegister(this.tenantContext.getTx());
  }

  @Get('sub-processors')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.PRIVACY_MANAGE)
  listSubProcessors() {
    return this.register.listSubProcessors(this.tenantContext.getTx());
  }

  @Get('retention-policies')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.PRIVACY_MANAGE)
  effectiveRetentionPolicies() {
    const tenantId = requireTenantId(this.tenantContext.tenantId);
    return this.register.effectiveRetentionPolicies(this.tenantContext.getTx(), tenantId);
  }

  @Put('retention-policies/:category')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.PRIVACY_MANAGE)
  @AuditLog('TenantDataRetentionOverride', AUDIT_ACTIONS.UPDATE)
  setRetentionOverride(
    @Param('category', new ZodValidationPipe(dataCategorySchema)) category: string,
    @Body(new ZodValidationPipe(upsertTenantDataRetentionOverrideRequestSchema)) body: UpsertTenantDataRetentionOverrideInput,
  ) {
    const tenantId = requireTenantId(this.tenantContext.tenantId);
    return this.register.upsertOverride(this.tenantContext.getTx(), tenantId, category as never, body.retentionMonths);
  }

  @Delete('retention-policies/:category')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.PRIVACY_MANAGE)
  @AuditLog('TenantDataRetentionOverride', AUDIT_ACTIONS.DELETE)
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeRetentionOverride(@Param('category', new ZodValidationPipe(dataCategorySchema)) category: string): Promise<void> {
    const tenantId = requireTenantId(this.tenantContext.tenantId);
    await this.register.removeOverride(this.tenantContext.getTx(), tenantId, category as never);
  }
}
