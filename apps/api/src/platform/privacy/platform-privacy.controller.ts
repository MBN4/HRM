import { Body, Controller, Delete, Get, Param, Post, Put, Query, UseInterceptors } from '@nestjs/common';
import type { DataSubjectRequest } from '@hrm/db';
import {
  createDataSubjectRequestSchema,
  CreateDataSubjectRequestInput,
  dataCategoryParamSchema,
  PLATFORM_PERMISSIONS,
  platformPrivacyRequestQuerySchema,
  PlatformPrivacyRequestQuery,
  updateDataRetentionPolicyRequestSchema,
  UpdateDataRetentionPolicyInput,
  upsertSubProcessorRequestSchema,
  UpsertSubProcessorInput,
} from '@hrm/shared';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { PlatformRoute } from '../../tenancy/platform-route.decorator';
import { TenantContextService } from '../../tenancy/tenant-context.service';
import { RequirePlatformPermissions } from '../decorators/require-platform-permissions.decorator';
import { PlatformPermissionsGuard } from '../guards/platform-permissions.guard';
import { PlatformPrivacyService } from './platform-privacy.service';

/**
 * The vendor console's surface over step 6.1's privacy engines — see
 * docs/conventions/privacy-residency.md. READ (register/retention-policy/
 * sub-processor/residency-overview/cross-tenant request listing) is
 * support-safe (both platform roles); MANAGE (authoring the catalog,
 * changing retention policy, creating a request on a tenant's behalf) is
 * PLATFORM_OWNER-only — the SAME "READ is broad, MANAGE is narrow" split
 * BILLING_READ/BILLING_MANAGE and PARTITIONING_READ/PARTITIONING_MANAGE
 * already establish.
 */
@Controller('platform/privacy')
@PlatformRoute()
@UseInterceptors(PlatformPermissionsGuard)
export class PlatformPrivacyController {
  constructor(
    private readonly privacy: PlatformPrivacyService,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Get('register')
  @RequirePlatformPermissions(PLATFORM_PERMISSIONS.PRIVACY_READ)
  listRegister() {
    return this.privacy.listRegister();
  }

  @Get('retention-policies')
  @RequirePlatformPermissions(PLATFORM_PERMISSIONS.PRIVACY_READ)
  listRetentionPolicies() {
    return this.privacy.listRetentionPolicies();
  }

  @Put('retention-policies/:category')
  @RequirePlatformPermissions(PLATFORM_PERMISSIONS.PRIVACY_MANAGE)
  updateRetentionPolicy(
    @Param('category', new ZodValidationPipe(dataCategoryParamSchema)) category: string,
    @Body(new ZodValidationPipe(updateDataRetentionPolicyRequestSchema)) body: UpdateDataRetentionPolicyInput,
  ) {
    return this.privacy.updateRetentionPolicy(this.requireActorId(), category as never, body);
  }

  @Get('sub-processors')
  @RequirePlatformPermissions(PLATFORM_PERMISSIONS.PRIVACY_READ)
  listSubProcessors() {
    return this.privacy.listSubProcessors();
  }

  @Post('sub-processors')
  @RequirePlatformPermissions(PLATFORM_PERMISSIONS.PRIVACY_MANAGE)
  createSubProcessor(@Body(new ZodValidationPipe(upsertSubProcessorRequestSchema)) body: UpsertSubProcessorInput) {
    return this.privacy.createSubProcessor(this.requireActorId(), body);
  }

  @Put('sub-processors/:id')
  @RequirePlatformPermissions(PLATFORM_PERMISSIONS.PRIVACY_MANAGE)
  updateSubProcessor(@Param('id') id: string, @Body(new ZodValidationPipe(upsertSubProcessorRequestSchema)) body: UpsertSubProcessorInput) {
    return this.privacy.updateSubProcessor(this.requireActorId(), id, body);
  }

  @Delete('sub-processors/:id')
  @RequirePlatformPermissions(PLATFORM_PERMISSIONS.PRIVACY_MANAGE)
  async deleteSubProcessor(@Param('id') id: string): Promise<{ deleted: true }> {
    await this.privacy.deleteSubProcessor(this.requireActorId(), id);
    return { deleted: true };
  }

  @Get('residency-overview')
  @RequirePlatformPermissions(PLATFORM_PERMISSIONS.PRIVACY_READ)
  residencyOverview() {
    return this.privacy.residencyOverview();
  }

  @Post('retention-sweep/run')
  @RequirePlatformPermissions(PLATFORM_PERMISSIONS.PRIVACY_MANAGE)
  runRetentionSweepNow() {
    return this.privacy.runRetentionSweepNow(this.requireActorId());
  }

  @Get('requests')
  @RequirePlatformPermissions(PLATFORM_PERMISSIONS.PRIVACY_READ)
  listRequests(@Query(new ZodValidationPipe(platformPrivacyRequestQuerySchema)) query: PlatformPrivacyRequestQuery): Promise<DataSubjectRequest[]> {
    return this.privacy.listRequests(this.requireActorId(), query);
  }

  @Post('tenants/:tenantId/requests')
  @RequirePlatformPermissions(PLATFORM_PERMISSIONS.PRIVACY_MANAGE)
  createRequestOnBehalf(
    @Param('tenantId') tenantId: string,
    @Body(new ZodValidationPipe(createDataSubjectRequestSchema)) body: CreateDataSubjectRequestInput,
  ): Promise<DataSubjectRequest> {
    return this.privacy.createRequestOnBehalf(this.requireActorId(), tenantId, body);
  }

  private requireActorId(): string {
    const id = this.tenantContext.platformAdminId;
    if (!id) {
      throw new Error('Unreachable: this route requires an authenticated platform admin.');
    }
    return id;
  }
}
