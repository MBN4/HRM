import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, UseInterceptors } from '@nestjs/common';
import { createApiKeySchema, FEATURE_FLAGS, PERMISSIONS, type CreateApiKeyInput } from '@hrm/shared';
import { AuditLog } from '../../audit/audit-log.decorator';
import { AuditInterceptor } from '../../audit/audit.interceptor';
import { RequirePermissions } from '../../auth/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../../auth/guards/permissions.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { FeatureFlagGuard } from '../../licensing/feature-flag.guard';
import { RequireFeature } from '../../licensing/require-feature.decorator';
import { TenantContextService } from '../../tenancy/tenant-context.service';
import { ApiKeyService } from './api-key.service';

/**
 * API key management (step 3.3) — `api_key.manage`-gated (TENANT_ADMIN
 * only), `FEATURE_FLAGS.API_ACCESS`-gated on creation (the SAME flag
 * already seeded since 0.6 for "may integrate programmatically" — reused,
 * not a new flag). Deliberately JWT-only (no route here accepts an
 * `X-Api-Key` itself) — minting/revoking the credential that grants API
 * access is intentionally a step ABOVE what an API key itself can do, the
 * same reasoning a cloud provider's own console access key management is
 * never itself gated by one of its own access keys.
 */
@Controller('integrations/api-keys')
export class ApiKeyController {
  constructor(
    private readonly apiKeys: ApiKeyService,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Get()
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.API_KEY_MANAGE)
  list() {
    return this.apiKeys.list(this.tenantContext.getTx(), this.requireTenantId());
  }

  @Post()
  @UseInterceptors(FeatureFlagGuard, PermissionsGuard, AuditInterceptor)
  @RequireFeature(FEATURE_FLAGS.API_ACCESS)
  @RequirePermissions(PERMISSIONS.API_KEY_MANAGE)
  @AuditLog('ApiKey', 'CREATE')
  async create(@Body(new ZodValidationPipe(createApiKeySchema)) body: CreateApiKeyInput) {
    const { apiKey, rawKey } = await this.apiKeys.create(this.tenantContext.getTx(), this.requireTenantId(), this.requireUserId(), body);
    // The ONLY response that ever carries the raw key — shown exactly once.
    return { ...apiKey, rawKey };
  }

  @Delete(':id')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.API_KEY_MANAGE)
  @AuditLog('ApiKey', 'REVOKE')
  @HttpCode(HttpStatus.OK)
  revoke(@Param('id') id: string) {
    return this.apiKeys.revoke(this.tenantContext.getTx(), this.requireTenantId(), id);
  }

  private requireTenantId(): string {
    const tenantId = this.tenantContext.tenantId;
    if (!tenantId) {
      throw new Error('Unreachable: this route always runs within a resolved tenant.');
    }
    return tenantId;
  }

  private requireUserId(): string {
    const userId = this.tenantContext.userId;
    if (!userId) {
      throw new Error('Unreachable: this route requires authentication.');
    }
    return userId;
  }
}
