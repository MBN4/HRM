import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  UseInterceptors,
} from '@nestjs/common';
import {
  copyRosterSchema,
  createShiftDefinitionSchema,
  createShiftSwapSchema,
  myScheduleQuerySchema,
  PERMISSIONS,
  publishRosterSchema,
  respondShiftSwapSchema,
  rosterGridQuerySchema,
  setRosterCellsSchema,
  setStandingShiftSchema,
  updateShiftDefinitionSchema,
  type CopyRosterInput,
  type CreateShiftDefinitionInput,
  type CreateShiftSwapInput,
  type MyScheduleQuery,
  type PublishRosterInput,
  type RespondShiftSwapInput,
  type RosterGridQuery,
  type SetRosterCellsInput,
  type SetStandingShiftInput,
  type UpdateShiftDefinitionInput,
} from '@hrm/shared';
import { AuditLog } from '../audit/audit-log.decorator';
import { AuditInterceptor } from '../audit/audit.interceptor';
import { ShiftsService } from '../attendance/shifts/shifts.service';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { MyScheduleService } from './my-schedule.service';
import { RosterGridService } from './roster-grid.service';
import { RosterService } from './roster.service';
import { SchedulingActor, SchedulingScopeService } from './scheduling-scope.service';
import { ShiftSwapService } from './shift-swap.service';
import { StandingShiftService } from './standing-shift.service';

/**
 * Shift scheduling & rostering API (step 8.2) — see docs/conventions/shift-scheduling.md.
 *
 * Permissions: managing anything needs `scheduling.manage`; WHO you may act on is then decided by
 * the service layer (branch scope, then hierarchy — a manager only their reporting chain; defining
 * shifts / team+company standing shifts need tenant-wide authority = `working_hours.manage`).
 * Reading shifts, your own schedule and requesting/answering swaps need only `attendance.read`/`.write`.
 * There is deliberately NO swap approve route: approval is the generic 0.7 workflow engine.
 */
@Controller('scheduling')
export class SchedulingController {
  constructor(
    private readonly shifts: ShiftsService,
    private readonly standing: StandingShiftService,
    private readonly roster: RosterService,
    private readonly grid: RosterGridService,
    private readonly mySchedule: MyScheduleService,
    private readonly swaps: ShiftSwapService,
    private readonly scope: SchedulingScopeService,
    private readonly tenantContext: TenantContextService,
  ) {}

  // --- shifts ----------------------------------------------------------

  @Get('shifts')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.ATTENDANCE_READ)
  listShifts() {
    return this.shifts.listShiftsWithUsage(this.tx());
  }

  @Post('shifts')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.SCHEDULING_MANAGE)
  @AuditLog('ShiftDefinition', 'CREATE')
  createShift(
    @Body(new ZodValidationPipe(createShiftDefinitionSchema)) body: CreateShiftDefinitionInput,
  ) {
    this.requireTenantWide('define shifts');
    return this.shifts.createShift(this.tx(), this.tenantId(), body);
  }

  @Patch('shifts/:id')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.SCHEDULING_MANAGE)
  @AuditLog('ShiftDefinition', 'UPDATE')
  updateShift(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateShiftDefinitionSchema)) body: UpdateShiftDefinitionInput,
  ) {
    this.requireTenantWide('edit shifts');
    return this.shifts.updateShift(this.tx(), id, body);
  }

  @Delete('shifts/:id')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.SCHEDULING_MANAGE)
  @AuditLog('ShiftDefinition', 'DELETE')
  deleteShift(@Param('id', ParseUUIDPipe) id: string) {
    this.requireTenantWide('delete shifts');
    return this.shifts.deleteShift(this.tx(), id);
  }

  // --- standing assignment ---------------------------------------------

  @Get('standing')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.SCHEDULING_MANAGE)
  listStanding() {
    return this.standing.list(this.tx(), this.actor());
  }

  @Put('standing/company')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.SCHEDULING_MANAGE)
  @AuditLog('StandingShift', 'SET_COMPANY')
  setCompany(@Body(new ZodValidationPipe(setStandingShiftSchema)) body: SetStandingShiftInput) {
    return this.standing.setCompany(
      this.tx(),
      this.tenantId(),
      this.actor(),
      body.shiftDefinitionId,
    );
  }

  @Put('standing/teams/:departmentId')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.SCHEDULING_MANAGE)
  @AuditLog('StandingShift', 'SET_TEAM')
  setTeam(
    @Param('departmentId', ParseUUIDPipe) departmentId: string,
    @Body(new ZodValidationPipe(setStandingShiftSchema)) body: SetStandingShiftInput,
  ) {
    return this.standing.setTeam(
      this.tx(),
      this.tenantId(),
      this.actor(),
      departmentId,
      body.shiftDefinitionId,
    );
  }

  @Put('standing/members/:employeeId')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.SCHEDULING_MANAGE)
  @AuditLog('StandingShift', 'SET_MEMBER')
  setMember(
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @Body(new ZodValidationPipe(setStandingShiftSchema)) body: SetStandingShiftInput,
  ) {
    return this.standing.setMember(
      this.tx(),
      this.tenantId(),
      this.actor(),
      employeeId,
      body.shiftDefinitionId,
    );
  }

  @Delete('standing/company')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.SCHEDULING_MANAGE)
  @AuditLog('StandingShift', 'REMOVE_COMPANY')
  removeCompany() {
    return this.standing.removeCompany(this.tx(), this.actor());
  }

  @Delete('standing/teams/:departmentId')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.SCHEDULING_MANAGE)
  @AuditLog('StandingShift', 'REMOVE_TEAM')
  removeTeam(@Param('departmentId', ParseUUIDPipe) departmentId: string) {
    return this.standing.removeTeam(this.tx(), this.actor(), departmentId);
  }

  @Delete('standing/members/:employeeId')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.SCHEDULING_MANAGE)
  @AuditLog('StandingShift', 'REMOVE_MEMBER')
  removeMember(@Param('employeeId', ParseUUIDPipe) employeeId: string) {
    return this.standing.removeMember(this.tx(), this.actor(), employeeId);
  }

  // --- roster calendar -------------------------------------------------

  /** Pickers for the roster UI: the teams and people the caller may schedule. */
  @Get('people')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.SCHEDULING_MANAGE)
  async people() {
    const actor = this.actor();
    const tx = this.tx();
    const employees = await this.scope.listSchedulableEmployees(tx, actor, {});
    const deptIds = [
      ...new Set(employees.map((e) => e.departmentId).filter((d): d is string => !!d)),
    ];
    const departments = await tx.department.findMany({
      where: actor.tenantWide
        ? actor.branchIds
          ? { branchId: { in: actor.branchIds } }
          : {}
        : { id: { in: deptIds } },
      select: { id: true, name: true, branch: { select: { name: true } } },
      orderBy: { name: 'asc' },
      take: 2000,
    });
    return {
      tenantWide: actor.tenantWide,
      departments: departments.map((d) => ({ id: d.id, name: d.name, branchName: d.branch.name })),
      employees: employees.map((e) => ({
        id: e.id,
        code: e.employeeCode,
        name: `${e.firstName} ${e.lastName}`,
        departmentId: e.departmentId,
        branchId: e.branchId,
      })),
    };
  }

  @Get('roster')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.SCHEDULING_MANAGE)
  rosterGrid(@Query(new ZodValidationPipe(rosterGridQuerySchema)) query: RosterGridQuery) {
    return this.grid.grid(this.tx(), this.tenantId(), this.actor(), query);
  }

  @Get('coverage')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.SCHEDULING_MANAGE)
  coverage(@Query(new ZodValidationPipe(rosterGridQuerySchema)) query: RosterGridQuery) {
    return this.grid.coverage(this.tx(), this.tenantId(), this.actor(), query);
  }

  @Put('roster/cells')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.SCHEDULING_MANAGE)
  @AuditLog('Roster', 'SET_CELLS')
  setCells(@Body(new ZodValidationPipe(setRosterCellsSchema)) body: SetRosterCellsInput) {
    return this.roster.setCells(this.tx(), this.tenantId(), this.actor(), body);
  }

  @Post('roster/copy')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.SCHEDULING_MANAGE)
  @AuditLog('Roster', 'COPY')
  copy(@Body(new ZodValidationPipe(copyRosterSchema)) body: CopyRosterInput) {
    return this.roster.copy(this.tx(), this.tenantId(), this.actor(), body);
  }

  @Post('roster/publish')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.SCHEDULING_MANAGE)
  @AuditLog('Roster', 'PUBLISH')
  publish(@Body(new ZodValidationPipe(publishRosterSchema)) body: PublishRosterInput) {
    return this.roster.publish(this.tx(), this.tenantId(), this.actor(), body);
  }

  // --- employee self-service -------------------------------------------

  @Get('my-schedule')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.ATTENDANCE_READ)
  myScheduleRoute(@Query(new ZodValidationPipe(myScheduleQuerySchema)) query: MyScheduleQuery) {
    return this.mySchedule.mine(this.tx(), this.tenantId(), this.userId(), query);
  }

  /** Colleagues you could hand a shift to: active, with a login, same branch as you. */
  @Get('colleagues')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.ATTENDANCE_READ)
  async colleagues() {
    const tx = this.tx();
    const own = await tx.employee.findFirst({
      where: { userId: this.userId() },
      select: { id: true, branchId: true },
    });
    if (!own) return [];
    const rows = await tx.employee.findMany({
      where: {
        branchId: own.branchId,
        status: 'ACTIVE',
        userId: { not: null },
        id: { not: own.id },
      },
      select: { id: true, firstName: true, lastName: true, departmentId: true },
      orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
      take: 500,
    });
    return rows.map((r) => ({
      id: r.id,
      name: `${r.firstName} ${r.lastName}`,
      departmentId: r.departmentId,
    }));
  }

  // --- swaps (approval = the generic workflow engine; no approve route here) ----

  @Get('swaps')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.ATTENDANCE_READ)
  listSwaps(@Query('scope') scope?: string) {
    const team = scope === 'team';
    if (team && !this.tenantContext.hasPermission(PERMISSIONS.SCHEDULING_MANAGE)) {
      throw new ForbiddenException("scheduling.manage is required to list your team's swaps.");
    }
    return this.swaps.list(
      this.tx(),
      this.userId(),
      team ? 'team' : 'mine',
      team ? this.actor() : null,
    );
  }

  @Post('swaps')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.ATTENDANCE_WRITE)
  @AuditLog('ShiftSwapRequest', 'CREATE')
  createSwap(@Body(new ZodValidationPipe(createShiftSwapSchema)) body: CreateShiftSwapInput) {
    return this.swaps.create(this.tx(), this.tenantId(), this.userId(), body);
  }

  @Post('swaps/:id/respond')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.ATTENDANCE_WRITE)
  @AuditLog('ShiftSwapRequest', 'RESPOND')
  respondSwap(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(respondShiftSwapSchema)) body: RespondShiftSwapInput,
  ) {
    return this.swaps.respond(this.tx(), this.tenantId(), this.userId(), id, body.accept);
  }

  @Post('swaps/:id/cancel')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.ATTENDANCE_WRITE)
  @AuditLog('ShiftSwapRequest', 'CANCEL')
  cancelSwap(@Param('id', ParseUUIDPipe) id: string) {
    return this.swaps.cancel(this.tx(), this.tenantId(), this.userId(), id);
  }

  // --- helpers ---------------------------------------------------------

  private actor(): SchedulingActor {
    return {
      userId: this.userId(),
      branchIds: this.tenantContext.getBranchIds(),
      tenantWide: this.tenantContext.hasPermission(PERMISSIONS.WORKING_HOURS_MANAGE),
    };
  }

  private requireTenantWide(what: string) {
    if (!this.tenantContext.hasPermission(PERMISSIONS.WORKING_HOURS_MANAGE)) {
      throw new ForbiddenException(
        `Only HR / admin / CEO (tenant-wide scheduling authority) can ${what}.`,
      );
    }
  }

  private tx() {
    return this.tenantContext.getTx();
  }

  private userId(): string {
    const id = this.tenantContext.userId;
    if (!id) throw new Error('Unreachable: this controller requires authentication.');
    return id;
  }

  private tenantId(): string {
    const id = this.tenantContext.tenantId;
    if (!id) throw new Error('Unreachable: tenant routes always run within a resolved tenant.');
    return id;
  }
}
