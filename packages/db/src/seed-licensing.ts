import type { Prisma, PrismaClient } from '@prisma/client';

type Client = PrismaClient | Prisma.TransactionClient;

/**
 * Seeds an ACTIVE PROFESSIONAL subscription for the demo tenant, so a
 * fresh dev environment has something for `FeatureFlagResolutionService`
 * to resolve in SaaS mode (the default `LICENSE_MODE`) without any manual
 * setup. Idempotent (upsert by the `tenantId` unique constraint).
 */
export async function seedDemoSubscription(client: Client, tenantId: string): Promise<void> {
  await client.subscription.upsert({
    where: { tenantId },
    update: {},
    create: { tenantId, edition: 'PROFESSIONAL', status: 'ACTIVE' },
  });
}
