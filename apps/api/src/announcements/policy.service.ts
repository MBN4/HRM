import { Injectable, NotFoundException } from '@nestjs/common';
import type { Policy, PolicyAcknowledgment, Prisma } from '@hrm/db';
import { CreatePolicyInput } from '@hrm/shared';

/**
 * Policies + e-acknowledgment tracking — see
 * docs/conventions/operations-modules.md. `version`/`isActive` mirror
 * `CountryPack`'s own versioned-reference-data shape (at tenant scope) —
 * see the schema's own doc comment: republishing is a NEW row, never an
 * in-place edit, so a `PolicyAcknowledgment` always means "acknowledged
 * THIS exact version."
 */
@Injectable()
export class PolicyService {
  async create(tx: Prisma.TransactionClient, tenantId: string, callerUserId: string, input: CreatePolicyInput): Promise<Policy> {
    const previous = await tx.policy.findFirst({ where: { tenantId, title: input.title }, orderBy: { version: 'desc' } });
    const version = (previous?.version ?? 0) + 1;
    if (previous?.isActive) {
      await tx.policy.update({ where: { id: previous.id }, data: { isActive: false } });
    }
    return tx.policy.create({
      data: {
        tenantId,
        title: input.title,
        body: input.body,
        version,
        requiresAcknowledgment: input.requiresAcknowledgment,
        publishedByUserId: callerUserId,
        publishedAt: input.publish ? new Date() : null,
      },
    });
  }

  async publish(tx: Prisma.TransactionClient, tenantId: string, id: string): Promise<Policy> {
    const policy = await this.requireById(tx, tenantId, id);
    if (policy.publishedAt) {
      return policy;
    }
    return tx.policy.update({ where: { id: policy.id }, data: { publishedAt: new Date() } });
  }

  async listForAdmin(tx: Prisma.TransactionClient, tenantId: string): Promise<Policy[]> {
    return tx.policy.findMany({ where: { tenantId }, orderBy: [{ title: 'asc' }, { version: 'desc' }] });
  }

  /** The ESS read: every currently-ACTIVE, PUBLISHED policy version. */
  async listActive(tx: Prisma.TransactionClient, tenantId: string): Promise<Policy[]> {
    return tx.policy.findMany({ where: { tenantId, isActive: true, publishedAt: { not: null } }, orderBy: { title: 'asc' } });
  }

  async acknowledge(tx: Prisma.TransactionClient, tenantId: string, policyId: string, userId: string): Promise<PolicyAcknowledgment> {
    const policy = await this.requireById(tx, tenantId, policyId);
    return tx.policyAcknowledgment.upsert({
      where: { tenantId_policyId_userId: { tenantId, policyId: policy.id, userId } },
      update: {},
      create: { tenantId, policyId: policy.id, userId },
    });
  }

  /** Raw acknowledgment rows for admin tracking — the portal cross-references `userId` against `GET /employees` for who has/hasn't acknowledged, the same "no dedicated picker/join endpoint" posture frontend-admin-console.md already documents for interviewer/manager pickers. */
  async listAcknowledgments(tx: Prisma.TransactionClient, tenantId: string, policyId: string): Promise<PolicyAcknowledgment[]> {
    await this.requireById(tx, tenantId, policyId);
    return tx.policyAcknowledgment.findMany({ where: { tenantId, policyId }, orderBy: { acknowledgedAt: 'asc' } });
  }

  async myAcknowledgments(tx: Prisma.TransactionClient, tenantId: string, userId: string): Promise<PolicyAcknowledgment[]> {
    return tx.policyAcknowledgment.findMany({ where: { tenantId, userId } });
  }

  private async requireById(tx: Prisma.TransactionClient, tenantId: string, id: string): Promise<Policy> {
    const policy = await tx.policy.findFirst({ where: { tenantId, id } });
    if (!policy) {
      throw new NotFoundException(`Policy "${id}" was not found.`);
    }
    return policy;
  }
}
