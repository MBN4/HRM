import { BadRequestException, Body, Controller, Get, Post, Query, UseInterceptors } from '@nestjs/common';
import { PERMISSIONS, runAnalyticsRollupSchema, RunAnalyticsRollupInput } from '@hrm/shared';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { AnalyticsDashboardService } from './dashboard/analytics-dashboard.service';
import { AnalyticsRollupService } from './rollup/analytics-rollup.service';
import { yesterdayUtc } from './rollup/analytics-rollup.util';

const DEFAULT_RANGE_DAYS = 30;

function requireTenantId(tenantId: string | null): string {
  if (!tenantId) {
    throw new BadRequestException('No tenant context is bound to this request.');
  }
  return tenantId;
}

function parseDate(value: string | undefined, field: string): Date | undefined {
  if (value === undefined) {
    return undefined;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new BadRequestException(`${field} must be a valid date.`);
  }
  return date;
}

/**
 * The analytics dashboard's read route and the manual rollup-backfill
 * lever — see docs/conventions/analytics-dashboard.md. Both gated by ONE
 * permission, `analytics.read` — this is a manager+ feature with no
 * "view your own" carve-out the way `leave.approve`/`attendance.approve`
 * need one (there is no per-employee ROW to narrow to here, only branch
 * scope, already enforced inside `AnalyticsDashboardService`).
 */
@Controller('analytics')
export class AnalyticsController {
  constructor(
    private readonly dashboard: AnalyticsDashboardService,
    private readonly rollup: AnalyticsRollupService,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Get('dashboard')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.ANALYTICS_READ)
  async getDashboard(
    @Query('branchId') branchId?: string,
    @Query('departmentId') departmentId?: string,
    @Query('from') fromRaw?: string,
    @Query('to') toRaw?: string,
  ) {
    const to = parseDate(toRaw, 'to') ?? yesterdayUtc();
    const from = parseDate(fromRaw, 'from') ?? addDays(to, -DEFAULT_RANGE_DAYS);
    if (from > to) {
      throw new BadRequestException('from must be on or before to.');
    }

    return this.dashboard.getDashboard(this.tenantContext.getTx(), this.tenantContext.getBranchIds(), {
      branchId,
      departmentId,
      from,
      to,
    });
  }

  /** Manual backfill/test lever — the SAME "manual trigger, HR/admin lever" shape 1.2/1.3 already establish alongside their own (unscheduled) jobs; this module's own equivalent job IS scheduled (see AnalyticsRollupService), this route exists for backfill and tests. */
  @Post('rollup/run')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.ANALYTICS_READ)
  async runRollup(@Body(new ZodValidationPipe(runAnalyticsRollupSchema)) body: RunAnalyticsRollupInput) {
    const tenantId = requireTenantId(this.tenantContext.tenantId);
    const date = body.date ?? yesterdayUtc();
    await this.rollup.enqueueTenantRollup(tenantId, date);
    return { enqueued: true };
  }
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}
