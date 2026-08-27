import { BadRequestException, Body, Controller, Get, Param, Post, Put, UseInterceptors } from '@nestjs/common';
import type { CustomFieldDefinition } from '@hrm/db';
import {
  AUDIT_ACTIONS,
  defineCustomFieldSchema,
  DefineCustomFieldInput,
  PERMISSIONS,
  setCustomFieldValuesSchema,
  SetCustomFieldValuesInput,
} from '@hrm/shared';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { AuditLog } from '../audit/audit-log.decorator';
import { AuditInterceptor } from '../audit/audit.interceptor';
import { CustomFieldDefinitionService } from './custom-field-definition.service';
import { CustomFieldValueService, CustomFieldValueSetDto } from './custom-field-value.service';

/**
 * The generic custom-fields framework's demo/reference surface — see
 * /CLAUDE.md § Conventions → Custom fields. Definitions (`POST`/`GET
 * .../definitions/:entityType`) and values (`PUT`/`GET .../values/:entityType/:entityId`)
 * are gated on `custom_field.manage` for MUTATIONS only; reads are open to
 * any authenticated tenant user, same posture as e.g. `GET
 * /tenancy/branches` — listing field labels or an entity's current custom
 * values isn't itself sensitive. A future real entity module (Employee,
 * ...) is expected to enforce ITS OWN field-appropriate permission
 * (`employee.write`, ...) around calls into
 * `CustomFieldValueService`/`CustomFieldDefinitionService` directly,
 * rather than routing through this generic controller — `custom_field.manage`
 * here is this framework's own baseline, not a stand-in for every future
 * entity's real RBAC.
 */
@Controller('custom-fields')
export class CustomFieldsController {
  constructor(
    private readonly definitions: CustomFieldDefinitionService,
    private readonly values: CustomFieldValueService,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Post('definitions')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.CUSTOM_FIELD_MANAGE)
  @AuditLog('CustomFieldDefinition', 'DEFINE')
  async define(
    @Body(new ZodValidationPipe(defineCustomFieldSchema)) body: DefineCustomFieldInput,
  ): Promise<CustomFieldDefinition> {
    const tenantId = this.tenantContext.getContext().tenantId;
    if (!tenantId) {
      throw new BadRequestException('No tenant context is bound to this request.');
    }
    return this.definitions.define(this.tenantContext.getTx(), tenantId, body);
  }

  @Get('definitions/:entityType')
  async listDefinitions(@Param('entityType') entityType: string): Promise<CustomFieldDefinition[]> {
    return this.definitions.list(this.tenantContext.getTx(), entityType);
  }

  @Put('values/:entityType/:entityId')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.CUSTOM_FIELD_MANAGE)
  @AuditLog('CustomFieldValueSet', AUDIT_ACTIONS.UPDATE)
  async setValues(
    @Param('entityType') entityType: string,
    @Param('entityId') entityId: string,
    @Body(new ZodValidationPipe(setCustomFieldValuesSchema)) body: SetCustomFieldValuesInput,
  ): Promise<CustomFieldValueSetDto> {
    const tenantId = this.tenantContext.getContext().tenantId;
    if (!tenantId) {
      throw new BadRequestException('No tenant context is bound to this request.');
    }
    return this.values.setValues(this.tenantContext.getTx(), tenantId, entityType, entityId, body);
  }

  @Get('values/:entityType/:entityId')
  async getValues(
    @Param('entityType') entityType: string,
    @Param('entityId') entityId: string,
  ): Promise<CustomFieldValueSetDto> {
    return this.values.getValues(this.tenantContext.getTx(), entityType, entityId);
  }
}
