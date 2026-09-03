import { Body, Controller, Get, Put, UseInterceptors } from '@nestjs/common';
import { setSlackWorkspaceConfigSchema, PERMISSIONS, type SetSlackWorkspaceConfigInput } from '@hrm/shared';
import { AuditLog } from '../../audit/audit-log.decorator';
import { AuditInterceptor } from '../../audit/audit.interceptor';
import { RequirePermissions } from '../../auth/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../../auth/guards/permissions.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { TenantContextService } from '../../tenancy/tenant-context.service';
import { SlackConfigService } from './slack-config.service';

/** `integration.manage`-gated — never returns the decrypted webhook URL, the same write-only posture SSO's client secret takes. */
@Controller('integrations/slack')
export class SlackConfigController {
  constructor(
    private readonly slack: SlackConfigService,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Get('config')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.INTEGRATION_MANAGE)
  get() {
    return this.slack.get(this.tenantContext.getTx(), this.requireTenantId());
  }

  @Put('config')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.INTEGRATION_MANAGE)
  @AuditLog('SlackWorkspaceConfig', 'UPSERT')
  async put(@Body(new ZodValidationPipe(setSlackWorkspaceConfigSchema)) body: SetSlackWorkspaceConfigInput) {
    const row = await this.slack.upsert(this.tenantContext.getTx(), this.requireTenantId(), body);
    return { enabled: row.enabled };
  }

  private requireTenantId(): string {
    const tenantId = this.tenantContext.tenantId;
    if (!tenantId) {
      throw new Error('Unreachable: this route always runs within a resolved tenant.');
    }
    return tenantId;
  }
}
