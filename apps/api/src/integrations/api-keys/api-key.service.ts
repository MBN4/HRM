import { randomBytes } from 'node:crypto';
import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@hrm/db';
import type { CreateApiKeyInput } from '@hrm/shared';
import { API_KEY_PREFIX_LENGTH } from '../../auth/api-key/api-key-auth.service';
import { HashingService } from '../../common/hashing/hashing.service';

/** Never `hashedKey` — an argon2id hash is not reversible, but it's still an internal secret artifact this API must never echo back, the same posture every other credential in this step takes. */
const SAFE_SELECT = {
  id: true,
  tenantId: true,
  name: true,
  keyPrefix: true,
  scopes: true,
  status: true,
  rateLimitPerMinute: true,
  createdByUserId: true,
  lastUsedAt: true,
  expiresAt: true,
  revokedAt: true,
  createdAt: true,
} as const;

export type SafeApiKey = Prisma.ApiKeyGetPayload<{ select: typeof SAFE_SELECT }>;

/**
 * Public API key management (step 3.3) — tenant-scoped, `api_key.manage`-
 * gated (see `api-key.controller.ts`). The raw key is generated ONCE here
 * and returned to the caller ONLY in the create response; only its argon2id
 * HASH (`HashingService`, the SAME algorithm `PasswordService` uses for
 * user passwords) is ever stored — this service, like the DB, can never
 * reconstruct the raw key again, only `ApiKeyAuthService.validate` can
 * CHECK a presented one against it.
 */
@Injectable()
export class ApiKeyService {
  constructor(private readonly hashing: HashingService) {}

  async list(tx: Prisma.TransactionClient, tenantId: string): Promise<SafeApiKey[]> {
    return tx.apiKey.findMany({ where: { tenantId }, orderBy: { createdAt: 'desc' }, select: SAFE_SELECT });
  }

  async create(
    tx: Prisma.TransactionClient,
    tenantId: string,
    userId: string,
    input: CreateApiKeyInput,
  ): Promise<{ apiKey: SafeApiKey; rawKey: string }> {
    const rawKey = `hrm_${randomBytes(24).toString('base64url')}`;
    const keyPrefix = rawKey.slice(0, API_KEY_PREFIX_LENGTH);
    const hashedKey = await this.hashing.hash(rawKey);

    const apiKey = await tx.apiKey.create({
      data: {
        tenantId,
        name: input.name,
        keyPrefix,
        hashedKey,
        scopes: input.scopes,
        rateLimitPerMinute: input.rateLimitPerMinute,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : undefined,
        createdByUserId: userId,
      },
      select: SAFE_SELECT,
    });
    return { apiKey, rawKey };
  }

  async revoke(tx: Prisma.TransactionClient, tenantId: string, id: string): Promise<SafeApiKey> {
    const existing = await tx.apiKey.findUnique({ where: { tenantId_id: { tenantId, id } } });
    if (!existing) {
      throw new NotFoundException(`No API key "${id}" exists for this tenant.`);
    }
    return tx.apiKey.update({ where: { id }, data: { status: 'REVOKED', revokedAt: new Date() }, select: SAFE_SELECT });
  }
}
