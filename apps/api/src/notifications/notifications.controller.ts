import { Body, Controller, Get, NotFoundException, Param, Post, Put } from '@nestjs/common';
import { updateNotificationPreferencesSchema, UpdateNotificationPreferencesInput } from '@hrm/shared';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { NotificationPreferenceService } from './notification-preference.service';

/**
 * The recipient-facing half of the notification hub — every route is
 * implicitly scoped to `this.tenantContext.userId`, the caller's own
 * notifications/preferences only; there is no route to read or act on
 * another user's notifications (no permission would make that safe to
 * expose generically, so it simply doesn't exist), the same "inherently
 * self-scoped, no RBAC gate needed" posture `/auth/me` already has.
 */
@Controller('notifications')
export class NotificationsController {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly preferences: NotificationPreferenceService,
  ) {}

  /** The caller's own in-app notifications, newest first. */
  @Get()
  async list(): Promise<unknown> {
    const tx = this.tenantContext.getTx();
    const userId = this.tenantContext.userId!;
    const notifications = await tx.notification.findMany({
      where: { recipientUserId: userId, deliveries: { some: { channel: 'IN_APP' } } },
      include: { deliveries: { where: { channel: 'IN_APP' } } },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return notifications.map((n) => ({
      id: n.id,
      eventType: n.eventType,
      createdAt: n.createdAt,
      delivery: n.deliveries[0],
    }));
  }

  @Post(':deliveryId/read')
  async markRead(@Param('deliveryId') deliveryId: string): Promise<unknown> {
    const tx = this.tenantContext.getTx();
    const userId = this.tenantContext.userId!;
    const delivery = await tx.notificationDelivery.findUnique({
      where: { id: deliveryId },
      include: { notification: true },
    });
    if (!delivery || delivery.channel !== 'IN_APP' || delivery.notification.recipientUserId !== userId) {
      throw new NotFoundException(`In-app notification "${deliveryId}" was not found.`);
    }
    return tx.notificationDelivery.update({ where: { id: deliveryId }, data: { readAt: new Date() } });
  }

  @Get('preferences')
  async getPreferences(): Promise<unknown> {
    const tx = this.tenantContext.getTx();
    const userId = this.tenantContext.userId!;
    return this.preferences.listForUser(tx, userId);
  }

  @Put('preferences')
  async putPreferences(
    @Body(new ZodValidationPipe(updateNotificationPreferencesSchema)) body: UpdateNotificationPreferencesInput,
  ): Promise<unknown> {
    const tx = this.tenantContext.getTx();
    const tenantId = this.tenantContext.getContext().tenantId!;
    const userId = this.tenantContext.userId!;
    await this.preferences.setPreferences(tx, tenantId, userId, body.preferences);
    return this.preferences.listForUser(tx, userId);
  }
}
