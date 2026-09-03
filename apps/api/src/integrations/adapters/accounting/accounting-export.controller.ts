import { Controller, Inject, NotFoundException, Param, Post, UseInterceptors } from '@nestjs/common';
import { PERMISSIONS } from '@hrm/shared';
import { AuditLog } from '../../../audit/audit-log.decorator';
import { AuditInterceptor } from '../../../audit/audit.interceptor';
import { RequirePermissions } from '../../../auth/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../../../auth/guards/permissions.guard';
import { TenantContextService } from '../../../tenancy/tenant-context.service';
import { ACCOUNTING_ADAPTER } from './accounting-adapter.interface';
import type { AccountingAdapter } from './accounting-adapter.interface';

/**
 * Admin-triggered export into the accounting seam — `integration.manage`-
 * gated. Reads the run/claim directly off the caller's own RLS-scoped
 * transaction (an ordinary indexed by-id read, the same as any other
 * lookup in this codebase) and hands the ROW straight to the adapter —
 * this controller does no accounting-specific transformation of its own,
 * that's the adapter's job.
 */
@Controller('integrations/accounting')
export class AccountingExportController {
  constructor(
    private readonly tenantContext: TenantContextService,
    @Inject(ACCOUNTING_ADAPTER) private readonly accounting: AccountingAdapter,
  ) {}

  @Post('export/payroll-runs/:id')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.INTEGRATION_MANAGE)
  @AuditLog('AccountingExport', 'EXPORT_PAYROLL_RUN')
  async exportPayrollRun(@Param('id') id: string) {
    const run = await this.tenantContext.getTx().payrollRun.findUnique({ where: { id } });
    if (!run) {
      throw new NotFoundException(`Payroll run "${id}" was not found.`);
    }
    return this.accounting.exportPayrollRun(run);
  }

  @Post('export/expense-claims/:id')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.INTEGRATION_MANAGE)
  @AuditLog('AccountingExport', 'EXPORT_EXPENSE_CLAIM')
  async exportExpenseClaim(@Param('id') id: string) {
    const claim = await this.tenantContext.getTx().expenseClaim.findUnique({ where: { id } });
    if (!claim) {
      throw new NotFoundException(`Expense claim "${id}" was not found.`);
    }
    return this.accounting.exportExpenseClaim(claim);
  }
}
