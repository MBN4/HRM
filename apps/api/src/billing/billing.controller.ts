import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, UseInterceptors } from '@nestjs/common';
import {
  attachPaymentMethodRequestSchema,
  cancelSubscriptionRequestSchema,
  changePlanRequestSchema,
  PERMISSIONS,
  type AttachPaymentMethodInput,
  type CancelSubscriptionInput,
  type ChangePlanInput,
} from '@hrm/shared';
import { AuditLog } from '../audit/audit-log.decorator';
import { AuditInterceptor } from '../audit/audit.interceptor';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { BillingService } from './billing.service';

/**
 * The tenant portal's own billing surface (step 4.2) — current plan,
 * seats, invoices, payment method, upgrade/downgrade. Every route gated
 * behind `billing.manage` (TENANT_ADMIN only via `ALL_PERMISSIONS`,
 * deliberately not in `HR_MANAGER`'s list) — ownership/money territory,
 * the SAME reasoning `license.manage`/`audit.read` already document for
 * themselves. See docs/conventions/billing.md.
 */
@Controller('billing')
@UseInterceptors(PermissionsGuard)
@RequirePermissions(PERMISSIONS.BILLING_MANAGE)
export class BillingController {
  constructor(
    private readonly billing: BillingService,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Get('summary')
  summary() {
    return this.billing.getSummary(this.tenantContext.getTx(), this.requireTenantId());
  }

  @Post('plan')
  @UseInterceptors(AuditInterceptor)
  @AuditLog('Subscription', 'CHANGE_PLAN')
  changePlan(@Body(new ZodValidationPipe(changePlanRequestSchema)) body: ChangePlanInput) {
    return this.billing.changePlan(this.tenantContext.getTx(), this.requireTenantId(), body.edition);
  }

  @Post('cancel')
  @UseInterceptors(AuditInterceptor)
  @AuditLog('Subscription', 'CANCEL')
  cancel(@Body(new ZodValidationPipe(cancelSubscriptionRequestSchema)) body: CancelSubscriptionInput) {
    return this.billing.cancelSubscription(this.tenantContext.getTx(), this.requireTenantId(), body.atPeriodEnd);
  }

  @Post('setup-intent')
  createSetupIntent() {
    return this.billing.createSetupIntent(this.tenantContext.getTx(), this.requireTenantId());
  }

  @Post('payment-methods')
  @UseInterceptors(AuditInterceptor)
  @AuditLog('PaymentMethod', 'ATTACH')
  attachPaymentMethod(@Body(new ZodValidationPipe(attachPaymentMethodRequestSchema)) body: AttachPaymentMethodInput) {
    return this.billing.attachPaymentMethod(this.tenantContext.getTx(), this.requireTenantId(), body.paymentMethodId, body.setAsDefault ?? false);
  }

  @Delete('payment-methods/:id')
  @UseInterceptors(AuditInterceptor)
  @AuditLog('PaymentMethod', 'REMOVE')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removePaymentMethod(@Param('id') id: string) {
    await this.billing.removePaymentMethod(this.tenantContext.getTx(), this.requireTenantId(), id);
  }

  private requireTenantId(): string {
    const tenantId = this.tenantContext.tenantId;
    if (!tenantId) {
      throw new Error('Unreachable: this route always runs within a resolved tenant.');
    }
    return tenantId;
  }
}
