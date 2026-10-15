import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Patch,
  Query,
  UseInterceptors,
} from '@nestjs/common';
import {
  listKioskPinsQuerySchema,
  PERMISSIONS,
  registerKioskSchema,
  updateKioskSchema,
  type ListKioskPinsQuery,
  type RegisterKioskInput,
  type UpdateKioskInput,
} from '@hrm/shared';
import { AuditLog } from '../audit/audit-log.decorator';
import { AuditInterceptor } from '../audit/audit.interceptor';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { KioskPinService } from './kiosk-pin.service';
import { KioskService } from './kiosk.service';

/**
 * Kiosk administration (JWT + `kiosk.manage`) — register/edit/rotate/revoke devices, issue/reset/remove
 * employee PINs. Deliberately a SEPARATE controller (and a separate URL space, `/kiosks`) from the
 * device-facing `/kiosk/*` routes: nothing here is a `@KioskRoute()`, so a kiosk token is refused here
 * by `TenantScopeInterceptor` before RBAC is even consulted — a device cannot administer devices.
 */
@Controller('kiosks')
@UseInterceptors(PermissionsGuard)
@RequirePermissions(PERMISSIONS.KIOSK_MANAGE)
export class KioskAdminController {
  constructor(
    private readonly kiosks: KioskService,
    private readonly pins: KioskPinService,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Get()
  list() {
    return this.kiosks.list(this.tenantContext.getTx(), this.tenantContext.getBranchIds());
  }

  @Post()
  @UseInterceptors(AuditInterceptor)
  @AuditLog('Kiosk', 'REGISTER')
  async register(@Body(new ZodValidationPipe(registerKioskSchema)) body: RegisterKioskInput) {
    const { kiosk, token } = await this.kiosks.create(
      this.tenantContext.getTx(),
      this.requireTenantId(),
      this.requireUserId(),
      this.tenantContext.getBranchIds(),
      body,
    );
    // The ONLY responses that ever carry the raw device token (here and on rotate) — shown exactly once.
    return { ...kiosk, token };
  }

  // PIN routes are declared BEFORE `:id` routes so `pins` is never captured as an id.
  @Get('pins')
  listPins(@Query(new ZodValidationPipe(listKioskPinsQuerySchema)) query: ListKioskPinsQuery) {
    return this.pins.list(this.tenantContext.getTx(), this.tenantContext.getBranchIds(), query);
  }

  @Post('pins/:employeeId')
  @UseInterceptors(AuditInterceptor)
  @AuditLog('EmployeeKioskPin', 'ISSUE')
  async issuePin(@Param('employeeId', ParseUUIDPipe) employeeId: string) {
    const { pin, employee } = await this.pins.issue(
      this.tenantContext.getTx(),
      this.requireTenantId(),
      this.requireUserId(),
      employeeId,
      this.tenantContext.getBranchIds(),
    );
    // `id` = the employee (what the audit entry is about); `pin` is redacted in the audit log, returned once here.
    return {
      id: employee.id,
      employeeCode: employee.employeeCode,
      name: `${employee.firstName} ${employee.lastName}`,
      pin,
    };
  }

  @Delete('pins/:employeeId')
  @UseInterceptors(AuditInterceptor)
  @AuditLog('EmployeeKioskPin', 'REMOVE')
  @HttpCode(HttpStatus.OK)
  async removePin(@Param('employeeId', ParseUUIDPipe) employeeId: string) {
    await this.pins.remove(
      this.tenantContext.getTx(),
      this.requireTenantId(),
      employeeId,
      this.tenantContext.getBranchIds(),
    );
    return { id: employeeId, removed: true };
  }

  @Patch(':id')
  @UseInterceptors(AuditInterceptor)
  @AuditLog('Kiosk', 'UPDATE')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateKioskSchema)) body: UpdateKioskInput,
  ) {
    return this.kiosks.update(
      this.tenantContext.getTx(),
      id,
      this.tenantContext.getBranchIds(),
      body,
    );
  }

  @Post(':id/token')
  @UseInterceptors(AuditInterceptor)
  @AuditLog('Kiosk', 'ROTATE_TOKEN')
  async rotate(@Param('id', ParseUUIDPipe) id: string) {
    const { kiosk, token } = await this.kiosks.rotateToken(
      this.tenantContext.getTx(),
      id,
      this.tenantContext.getBranchIds(),
    );
    return { ...kiosk, token };
  }

  @Delete(':id')
  @UseInterceptors(AuditInterceptor)
  @AuditLog('Kiosk', 'REVOKE')
  @HttpCode(HttpStatus.OK)
  revoke(@Param('id', ParseUUIDPipe) id: string) {
    return this.kiosks.revoke(this.tenantContext.getTx(), id, this.tenantContext.getBranchIds());
  }

  @Get(':id/activity')
  activity(@Param('id', ParseUUIDPipe) id: string) {
    return this.kiosks.activity(this.tenantContext.getTx(), id, this.tenantContext.getBranchIds());
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
