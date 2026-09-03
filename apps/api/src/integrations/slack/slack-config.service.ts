import { Injectable } from '@nestjs/common';
import type { Prisma, SlackWorkspaceConfig } from '@hrm/db';
import type { SetSlackWorkspaceConfigInput } from '@hrm/shared';
import { EncryptionService } from '../../common/encryption/encryption.service';

/** Per-tenant Slack incoming-webhook config — see `SlackNotificationProvider` (`apps/api/src/notifications/providers/slack.provider.ts`), the actual delivery-side consumer of this row. */
@Injectable()
export class SlackConfigService {
  constructor(private readonly encryption: EncryptionService) {}

  async get(tx: Prisma.TransactionClient, tenantId: string): Promise<{ enabled: boolean } | null> {
    const row = await tx.slackWorkspaceConfig.findUnique({ where: { tenantId } });
    return row ? { enabled: row.enabled } : null;
  }

  async upsert(tx: Prisma.TransactionClient, tenantId: string, input: SetSlackWorkspaceConfigInput): Promise<SlackWorkspaceConfig> {
    const webhookUrlEncrypted = this.encryption.encrypt(input.webhookUrl);
    return tx.slackWorkspaceConfig.upsert({
      where: { tenantId },
      create: { tenantId, webhookUrlEncrypted, enabled: input.enabled },
      update: { webhookUrlEncrypted, enabled: input.enabled },
    });
  }
}
