import { Body, Controller, Get, Param, Post, UseInterceptors } from '@nestjs/common';
import type { Invoice } from '@hrm/db';
import { createAmcInvoiceRequestSchema, PLATFORM_PERMISSIONS, type CreateAmcInvoiceInput } from '@hrm/shared';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { PlatformRoute } from '../../tenancy/platform-route.decorator';
import { TenantContextService } from '../../tenancy/tenant-context.service';
import { RequirePlatformPermissions } from '../decorators/require-platform-permissions.decorator';
import { PlatformPermissionsGuard } from '../guards/platform-permissions.guard';
import { PlatformBillingService } from './platform-billing.service';

@Controller('platform/billing')
@PlatformRoute()
@UseInterceptors(PlatformPermissionsGuard)
export class PlatformBillingController {
  constructor(
    private readonly billing: PlatformBillingService,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Get('subscriptions')
  @RequirePlatformPermissions(PLATFORM_PERMISSIONS.BILLING_READ)
  listSubscriptions() {
    return this.billing.listSubscriptions();
  }

  @Get('tenants/:tenantId')
  @RequirePlatformPermissions(PLATFORM_PERMISSIONS.BILLING_READ)
  getTenantBilling(@Param('tenantId') tenantId: string) {
    return this.billing.getTenantBilling(tenantId);
  }

  @Post('tenants/:tenantId/amc-invoices')
  @RequirePlatformPermissions(PLATFORM_PERMISSIONS.BILLING_MANAGE)
  createAmcInvoice(
    @Param('tenantId') tenantId: string,
    @Body(new ZodValidationPipe(createAmcInvoiceRequestSchema)) body: CreateAmcInvoiceInput,
  ): Promise<Invoice> {
    return this.billing.createAmcInvoice(this.requireActorId(), tenantId, body);
  }

  @Post('tenants/:tenantId/resync')
  @RequirePlatformPermissions(PLATFORM_PERMISSIONS.BILLING_MANAGE)
  resync(@Param('tenantId') tenantId: string) {
    return this.billing.resyncSubscription(this.requireActorId(), tenantId);
  }

  private requireActorId(): string {
    const id = this.tenantContext.platformAdminId;
    if (!id) {
      throw new Error('Unreachable: this route requires an authenticated platform admin.');
    }
    return id;
  }
}
