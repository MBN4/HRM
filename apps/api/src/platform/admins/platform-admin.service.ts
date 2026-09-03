import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { prisma } from '@hrm/db';
import type { CreatePlatformAdminInput, UpdatePlatformAdminInput } from '@hrm/shared';
import { PasswordService } from '../../auth/password.service';
import { PlatformAuditRecordService } from '../audit/platform-audit-record.service';

export interface PlatformAdminSummary {
  id: string;
  email: string;
  name: string;
  role: string;
  status: string;
  mfaEnabled: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

function toSummary(admin: {
  id: string;
  email: string;
  name: string;
  role: string;
  status: string;
  mfaEnabled: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
}): PlatformAdminSummary {
  return {
    id: admin.id,
    email: admin.email,
    name: admin.name,
    role: admin.role,
    status: admin.status,
    mfaEnabled: admin.mfaEnabled,
    lastLoginAt: admin.lastLoginAt?.toISOString() ?? null,
    createdAt: admin.createdAt.toISOString(),
  };
}

/**
 * Manages OTHER platform admin accounts — the one permission
 * (`platform.admin.manage`) deliberately held by PLATFORM_OWNER only (see
 * `@hrm/shared`'s `PLATFORM_ROLE_PERMISSIONS`): a PLATFORM_SUPPORT admin
 * can never create a peer, promote themselves, or reactivate a suspended
 * account. A newly created admin is mfaEnabled=false — they complete their
 * own MFA enrollment on first login (`PlatformAuthService`); there is no
 * admin-assisted MFA bypass anywhere in this system.
 */
@Injectable()
export class PlatformAdminService {
  constructor(
    private readonly password: PasswordService,
    private readonly audit: PlatformAuditRecordService,
  ) {}

  async list(): Promise<PlatformAdminSummary[]> {
    const rows = await prisma.platformAdmin.findMany({ orderBy: { createdAt: 'asc' } });
    return rows.map(toSummary);
  }

  async create(actorId: string, input: CreatePlatformAdminInput): Promise<PlatformAdminSummary> {
    const existing = await prisma.platformAdmin.findUnique({ where: { email: input.email } });
    if (existing) {
      throw new ConflictException(`A platform admin with email "${input.email}" already exists.`);
    }
    const hashedPassword = await this.password.hash(input.password);
    const admin = await prisma.platformAdmin.create({
      data: { email: input.email, name: input.name, hashedPassword, role: input.role },
    });

    await this.audit.record({
      platformAdminId: actorId,
      action: 'platform.admin.created',
      entityType: 'PlatformAdmin',
      entityId: admin.id,
      after: { email: admin.email, name: admin.name, role: admin.role },
    });

    return toSummary(admin);
  }

  async update(actorId: string, id: string, input: UpdatePlatformAdminInput): Promise<PlatformAdminSummary> {
    const before = await prisma.platformAdmin.findUnique({ where: { id } });
    if (!before) {
      throw new NotFoundException(`Platform admin "${id}" was not found.`);
    }

    const admin = await prisma.platformAdmin.update({
      where: { id },
      data: { role: input.role, status: input.status },
    });

    await this.audit.record({
      platformAdminId: actorId,
      action: 'platform.admin.updated',
      entityType: 'PlatformAdmin',
      entityId: admin.id,
      before: { role: before.role, status: before.status },
      after: { role: admin.role, status: admin.status },
    });

    return toSummary(admin);
  }
}
