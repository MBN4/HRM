import { randomBytes } from 'node:crypto';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@hrm/db';
import type { RegisterKioskInput, UpdateKioskInput } from '@hrm/shared';
import { KIOSK_TOKEN_LABEL, KIOSK_TOKEN_PREFIX_LENGTH } from '../auth/kiosk/kiosk.constants';
import { HashingService } from '../common/hashing/hashing.service';
import { KIOSK_ONLINE_WINDOW_MS } from './kiosk.constants';

/** Never `hashedToken` — an internal secret artifact this API must never echo back, the same posture `ApiKeyService` takes. */
const SAFE_SELECT = {
  id: true,
  tenantId: true,
  branchId: true,
  name: true,
  tokenPrefix: true,
  status: true,
  requirePhoto: true,
  biometricEnabled: true,
  tokenIssuedAt: true,
  lastSeenAt: true,
  revokedAt: true,
  createdAt: true,
  branch: { select: { name: true } },
} as const;

type SafeKioskRow = Prisma.KioskGetPayload<{ select: typeof SAFE_SELECT }>;

export interface KioskView extends Omit<SafeKioskRow, 'branch'> {
  branchName: string;
  /** Called in within the last few minutes. */
  online: boolean;
}

function toView(row: SafeKioskRow): KioskView {
  const { branch, ...rest } = row;
  return {
    ...rest,
    branchName: branch.name,
    online:
      Boolean(row.lastSeenAt && Date.now() - row.lastSeenAt.getTime() < KIOSK_ONLINE_WINDOW_MS) &&
      row.status === 'ACTIVE',
  };
}

/**
 * Kiosk device management (`kiosk.manage`). The raw device token exists only in the response of
 * `create`/`rotateToken` — only its argon2id hash is stored.
 */
@Injectable()
export class KioskService {
  constructor(private readonly hashing: HashingService) {}

  async list(
    tx: Prisma.TransactionClient,
    allowedBranchIds: string[] | null,
  ): Promise<KioskView[]> {
    const rows = await tx.kiosk.findMany({
      where: allowedBranchIds ? { branchId: { in: allowedBranchIds } } : undefined,
      orderBy: { createdAt: 'desc' },
      select: SAFE_SELECT,
    });
    return rows.map(toView);
  }

  async create(
    tx: Prisma.TransactionClient,
    tenantId: string,
    userId: string,
    allowedBranchIds: string[] | null,
    input: RegisterKioskInput,
  ): Promise<{ kiosk: KioskView; token: string }> {
    const branch = await tx.branch.findUnique({
      where: { id: input.branchId },
      select: { id: true },
    });
    if (!branch || (allowedBranchIds && !allowedBranchIds.includes(branch.id))) {
      throw new NotFoundException(`Branch "${input.branchId}" was not found.`);
    }
    const credential = await this.mintCredential();
    const row = await tx.kiosk.create({
      data: {
        tenantId,
        branchId: input.branchId,
        name: input.name,
        requirePhoto: input.requirePhoto,
        biometricEnabled: input.biometricEnabled,
        createdByUserId: userId,
        tokenPrefix: credential.prefix,
        hashedToken: credential.hash,
      },
      select: SAFE_SELECT,
    });
    return { kiosk: toView(row), token: credential.raw };
  }

  async update(
    tx: Prisma.TransactionClient,
    id: string,
    allowedBranchIds: string[] | null,
    input: UpdateKioskInput,
  ): Promise<KioskView> {
    await this.requireKiosk(tx, id, allowedBranchIds);
    return toView(await tx.kiosk.update({ where: { id }, data: input, select: SAFE_SELECT }));
  }

  /** Issues a brand-new token (the old one stops working immediately) and re-activates a revoked kiosk. */
  async rotateToken(
    tx: Prisma.TransactionClient,
    id: string,
    allowedBranchIds: string[] | null,
  ): Promise<{ kiosk: KioskView; token: string }> {
    await this.requireKiosk(tx, id, allowedBranchIds);
    const credential = await this.mintCredential();
    const row = await tx.kiosk.update({
      where: { id },
      data: {
        tokenPrefix: credential.prefix,
        hashedToken: credential.hash,
        status: 'ACTIVE',
        revokedAt: null,
        tokenIssuedAt: new Date(),
        lastSeenAt: null,
      },
      select: SAFE_SELECT,
    });
    return { kiosk: toView(row), token: credential.raw };
  }

  async revoke(
    tx: Prisma.TransactionClient,
    id: string,
    allowedBranchIds: string[] | null,
  ): Promise<KioskView> {
    await this.requireKiosk(tx, id, allowedBranchIds);
    return toView(
      await tx.kiosk.update({
        where: { id },
        data: { status: 'REVOKED', revokedAt: new Date() },
        select: SAFE_SELECT,
      }),
    );
  }

  /** The most recent punches captured by this device (bounded), newest first. */
  async activity(
    tx: Prisma.TransactionClient,
    id: string,
    allowedBranchIds: string[] | null,
    limit = 25,
  ) {
    await this.requireKiosk(tx, id, allowedBranchIds);
    if (limit < 1 || limit > 100) {
      throw new BadRequestException('limit must be between 1 and 100.');
    }
    const records = await tx.attendanceRecord.findMany({
      where: { OR: [{ clockInKioskId: id }, { clockOutKioskId: id }] },
      orderBy: { updatedAt: 'desc' },
      take: limit,
      select: {
        id: true,
        employeeId: true,
        workDate: true,
        clockInAt: true,
        clockOutAt: true,
        clockInKioskId: true,
        clockOutKioskId: true,
        clockInPhotoKey: true,
        employee: { select: { employeeCode: true, firstName: true, lastName: true } },
      },
    });
    return records.map((r) => ({
      recordId: r.id,
      employeeId: r.employeeId,
      employeeCode: r.employee.employeeCode,
      employeeName: `${r.employee.firstName} ${r.employee.lastName}`,
      workDate: r.workDate.toISOString().slice(0, 10),
      clockInAt: r.clockInKioskId === id ? r.clockInAt.toISOString() : null,
      clockOutAt: r.clockOutKioskId === id && r.clockOutAt ? r.clockOutAt.toISOString() : null,
      hasPhoto: Boolean(r.clockInPhotoKey),
    }));
  }

  private async requireKiosk(
    tx: Prisma.TransactionClient,
    id: string,
    allowedBranchIds: string[] | null,
  ) {
    const kiosk = await tx.kiosk.findUnique({
      where: { id },
      select: { id: true, branchId: true },
    });
    if (!kiosk || (allowedBranchIds && !allowedBranchIds.includes(kiosk.branchId))) {
      throw new NotFoundException(`Kiosk "${id}" was not found.`);
    }
    return kiosk;
  }

  private async mintCredential(): Promise<{ raw: string; prefix: string; hash: string }> {
    const raw = `${KIOSK_TOKEN_LABEL}${randomBytes(32).toString('base64url')}`;
    return {
      raw,
      prefix: raw.slice(0, KIOSK_TOKEN_PREFIX_LENGTH),
      hash: await this.hashing.hash(raw),
    };
  }
}
