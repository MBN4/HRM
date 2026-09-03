import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Put, Query, UseInterceptors } from '@nestjs/common';
import type { WebhookDelivery } from '@hrm/db';
import {
  createWebhookSubscriptionSchema,
  updateWebhookSubscriptionSchema,
  FEATURE_FLAGS,
  PERMISSIONS,
  WEBHOOK_EVENT_TYPES,
  type CreateWebhookSubscriptionInput,
  type UpdateWebhookSubscriptionInput,
} from '@hrm/shared';
import { AuditLog } from '../../audit/audit-log.decorator';
import { AuditInterceptor } from '../../audit/audit.interceptor';
import { RequirePermissions } from '../../auth/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../../auth/guards/permissions.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { FeatureFlagGuard } from '../../licensing/feature-flag.guard';
import { RequireFeature } from '../../licensing/require-feature.decorator';
import { TenantContextService } from '../../tenancy/tenant-context.service';
import { WebhookSubscriptionService } from './webhook-subscription.service';

/**
 * Subscription management (outbound webhooks, step 3.3) — tenant-scoped,
 * `webhook.manage`-gated (TENANT_ADMIN only, ownership/security territory —
 * see `PERMISSIONS.WEBHOOK_MANAGE`'s doc comment), `FEATURE_FLAGS.WEBHOOKS`-
 * gated on every mutation, and `@AuditLog`'d — this step's own brief calls
 * out subscription changes as "especially" audit-worthy.
 */
@Controller('integrations/webhooks')
export class WebhookSubscriptionController {
  constructor(
    private readonly subscriptions: WebhookSubscriptionService,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Get('event-types')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.WEBHOOK_MANAGE)
  listEventTypes() {
    return { eventTypes: WEBHOOK_EVENT_TYPES };
  }

  @Get('subscriptions')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.WEBHOOK_MANAGE)
  list() {
    return this.subscriptions.list(this.tenantContext.getTx(), this.requireTenantId());
  }

  @Post('subscriptions')
  @UseInterceptors(FeatureFlagGuard, PermissionsGuard, AuditInterceptor)
  @RequireFeature(FEATURE_FLAGS.WEBHOOKS)
  @RequirePermissions(PERMISSIONS.WEBHOOK_MANAGE)
  @AuditLog('WebhookSubscription', 'CREATE')
  async create(@Body(new ZodValidationPipe(createWebhookSubscriptionSchema)) body: CreateWebhookSubscriptionInput) {
    const { subscription, signingSecret } = await this.subscriptions.create(
      this.tenantContext.getTx(),
      this.requireTenantId(),
      this.requireUserId(),
      body,
    );
    // The ONLY response that ever carries the plaintext signing secret —
    // the same "shown exactly once at creation" posture ApiKeyService's raw
    // key takes.
    return { ...subscription, signingSecret };
  }

  @Put('subscriptions/:id')
  @UseInterceptors(FeatureFlagGuard, PermissionsGuard, AuditInterceptor)
  @RequireFeature(FEATURE_FLAGS.WEBHOOKS)
  @RequirePermissions(PERMISSIONS.WEBHOOK_MANAGE)
  @AuditLog('WebhookSubscription', 'UPDATE')
  update(@Param('id') id: string, @Body(new ZodValidationPipe(updateWebhookSubscriptionSchema)) body: UpdateWebhookSubscriptionInput) {
    return this.subscriptions.update(this.tenantContext.getTx(), this.requireTenantId(), id, body);
  }

  @Delete('subscriptions/:id')
  @UseInterceptors(FeatureFlagGuard, PermissionsGuard, AuditInterceptor)
  @RequireFeature(FEATURE_FLAGS.WEBHOOKS)
  @RequirePermissions(PERMISSIONS.WEBHOOK_MANAGE)
  @AuditLog('WebhookSubscription', 'DELETE')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id') id: string) {
    await this.subscriptions.remove(this.tenantContext.getTx(), this.requireTenantId(), id);
  }

  /** The delivery log the brief asks for (attempts/status/response) — a bounded, filtered live read, the SAME "operational drill-down, not a rollup" posture the rest of this codebase already takes for admin list screens. */
  @Get('subscriptions/:id/deliveries')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.WEBHOOK_MANAGE)
  listDeliveries(@Param('id') id: string, @Query('limit') limit?: string): Promise<WebhookDelivery[]> {
    const take = Math.min(Math.max(Number(limit) || 50, 1), 200);
    return this.tenantContext
      .getTx()
      .webhookDelivery.findMany({ where: { webhookSubscriptionId: id }, orderBy: { createdAt: 'desc' }, take });
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
