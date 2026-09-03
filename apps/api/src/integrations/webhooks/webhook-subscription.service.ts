import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma, WebhookSubscription } from '@hrm/db';
import type { CreateWebhookSubscriptionInput, UpdateWebhookSubscriptionInput } from '@hrm/shared';
import { EncryptionService } from '../../common/encryption/encryption.service';
import { generateWebhookSigningSecret } from './webhook-signature.util';

/**
 * Webhook subscription management — tenant-scoped, RBAC-gated
 * (`webhook.manage`, see `webhook-subscription.controller.ts`). The signing
 * secret is generated ONCE at creation, shown in the create response ONLY,
 * and stored encrypted (`EncryptionService`, reversible — the dispatcher
 * needs the original value again to sign every delivery); a read-back never
 * returns it, the same "shown once" posture `ApiKeyService`'s raw key
 * takes, though this one is decryptable rather than hashed since it must be
 * usable again.
 */
@Injectable()
export class WebhookSubscriptionService {
  constructor(private readonly encryption: EncryptionService) {}

  async list(tx: Prisma.TransactionClient, tenantId: string): Promise<WebhookSubscription[]> {
    return tx.webhookSubscription.findMany({ where: { tenantId }, orderBy: { createdAt: 'desc' } });
  }

  async create(
    tx: Prisma.TransactionClient,
    tenantId: string,
    userId: string,
    input: CreateWebhookSubscriptionInput,
  ): Promise<{ subscription: WebhookSubscription; signingSecret: string }> {
    const signingSecret = generateWebhookSigningSecret();
    const subscription = await tx.webhookSubscription.create({
      data: {
        tenantId,
        url: input.url,
        description: input.description,
        eventTypes: input.eventTypes,
        signingSecretEncrypted: this.encryption.encrypt(signingSecret),
        createdByUserId: userId,
      },
    });
    return { subscription, signingSecret };
  }

  async update(
    tx: Prisma.TransactionClient,
    tenantId: string,
    id: string,
    input: UpdateWebhookSubscriptionInput,
  ): Promise<WebhookSubscription> {
    await this.requireOwned(tx, tenantId, id);
    return tx.webhookSubscription.update({
      where: { id },
      data: {
        url: input.url,
        description: input.description,
        eventTypes: input.eventTypes,
        status: input.status,
      },
    });
  }

  async remove(tx: Prisma.TransactionClient, tenantId: string, id: string): Promise<void> {
    await this.requireOwned(tx, tenantId, id);
    await tx.webhookSubscription.delete({ where: { id } });
  }

  private async requireOwned(tx: Prisma.TransactionClient, tenantId: string, id: string): Promise<WebhookSubscription> {
    // `tenantId_id` (not a bare `id`) — belt-and-suspenders alongside RLS,
    // the same composite-lookup posture every other tenant-scoped service
    // in this codebase takes for a by-id read.
    const subscription = await tx.webhookSubscription.findUnique({ where: { tenantId_id: { tenantId, id } } });
    if (!subscription) {
      throw new NotFoundException(`No webhook subscription "${id}" exists for this tenant.`);
    }
    return subscription;
  }
}
