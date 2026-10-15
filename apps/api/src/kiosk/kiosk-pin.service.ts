import { randomInt } from 'node:crypto';
import {
  BadRequestException,
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { Employee, Prisma } from '@hrm/db';
import { KIOSK_ISSUED_PIN_LENGTH, type ListKioskPinsQuery } from '@hrm/shared';
import { HashingService } from '../common/hashing/hashing.service';
import { REDIS_CLIENT } from '../redis/redis.constants';
import { KIOSK_ERROR, PIN_LOCK_SECONDS, PIN_MAX_FAILURES } from './kiosk.constants';

const failKey = (employeeId: string) => `kiosk:pin-fail:${employeeId}`;
const lockKey = (employeeId: string) => `kiosk:pin-lock:${employeeId}`;

export interface KioskPinStatusRow {
  employeeId: string;
  employeeCode: string;
  name: string;
  branchId: string;
  hasPin: boolean;
  issuedAt: Date | null;
  lastUsedAt: Date | null;
  locked: boolean;
}

/**
 * Employee kiosk PINs (admin-issued). A PIN is 6 random digits from a CSPRNG, shown to the admin ONCE
 * and stored only as an argon2id hash (`HashingService`, the same primitive passwords/API keys use) —
 * unrecoverable, only resettable.
 *
 * A PIN is a LOW-ENTROPY secret (10^6), so its safety does not come from the PIN: it comes from
 *   1. identification being `employeeCode` + PIN (the code selects one employee — an attacker cannot
 *      simply try PINs against "anyone"),
 *   2. a per-EMPLOYEE lockout (5 failures → 15 min, enforced in Redis so it survives a rolled-back
 *      request transaction — see `recordFailure`), and
 *   3. per-kiosk caps (KioskPunchService).
 * And even a fully compromised PIN only lets someone clock THAT employee in/out at THEIR branch's kiosk.
 */
@Injectable()
export class KioskPinService {
  /** Verified against when the employee/PIN doesn't exist, so an unknown code costs the same time as a wrong PIN. */
  private dummyHash: Promise<string> | null = null;

  constructor(
    private readonly hashing: HashingService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  /** Issues (or resets) an employee's PIN. Returns the plaintext ONCE. */
  async issue(
    tx: Prisma.TransactionClient,
    tenantId: string,
    issuerUserId: string,
    employeeId: string,
    allowedBranchIds: string[] | null,
  ): Promise<{
    pin: string;
    employee: Pick<Employee, 'id' | 'employeeCode' | 'firstName' | 'lastName' | 'branchId'>;
  }> {
    const employee = await this.requireEmployee(tx, employeeId, allowedBranchIds);
    if (employee.status !== 'ACTIVE') {
      throw new BadRequestException('A kiosk PIN can only be issued to an active employee.');
    }
    const pin = String(randomInt(0, 10 ** KIOSK_ISSUED_PIN_LENGTH)).padStart(
      KIOSK_ISSUED_PIN_LENGTH,
      '0',
    );
    const pinHash = await this.hashing.hash(pin);
    await tx.employeeKioskPin.upsert({
      where: { tenantId_employeeId: { tenantId, employeeId } },
      create: { tenantId, employeeId, pinHash, issuedByUserId: issuerUserId },
      update: { pinHash, issuedByUserId: issuerUserId, issuedAt: new Date(), lastUsedAt: null },
    });
    // A reset is also how HR unlocks someone.
    await this.redis.del(failKey(employeeId), lockKey(employeeId));
    return { pin, employee };
  }

  async remove(
    tx: Prisma.TransactionClient,
    tenantId: string,
    employeeId: string,
    allowedBranchIds: string[] | null,
  ): Promise<void> {
    await this.requireEmployee(tx, employeeId, allowedBranchIds);
    await tx.employeeKioskPin.deleteMany({ where: { tenantId, employeeId } });
    await this.redis.del(failKey(employeeId), lockKey(employeeId));
  }

  /** PIN status per employee — never the hash, never the PIN. Bounded by `limit`. */
  async list(
    tx: Prisma.TransactionClient,
    allowedBranchIds: string[] | null,
    query: ListKioskPinsQuery,
  ): Promise<KioskPinStatusRow[]> {
    const where: Prisma.EmployeeWhereInput = { status: 'ACTIVE' };
    if (query.branchId) {
      if (allowedBranchIds && !allowedBranchIds.includes(query.branchId)) {
        return [];
      }
      where.branchId = query.branchId;
    } else if (allowedBranchIds) {
      where.branchId = { in: allowedBranchIds };
    }
    if (query.search) {
      where.OR = [
        { employeeCode: { contains: query.search, mode: 'insensitive' } },
        { firstName: { contains: query.search, mode: 'insensitive' } },
        { lastName: { contains: query.search, mode: 'insensitive' } },
      ];
    }
    const employees = await tx.employee.findMany({
      where,
      orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
      take: query.limit,
      select: {
        id: true,
        employeeCode: true,
        firstName: true,
        lastName: true,
        branchId: true,
        kioskPin: { select: { issuedAt: true, lastUsedAt: true } },
      },
    });
    const locks = await Promise.all(employees.map((e) => this.redis.exists(lockKey(e.id))));
    return employees.map((e, i) => ({
      employeeId: e.id,
      employeeCode: e.employeeCode,
      name: `${e.firstName} ${e.lastName}`,
      branchId: e.branchId,
      hasPin: Boolean(e.kioskPin),
      issuedAt: e.kioskPin?.issuedAt ?? null,
      lastUsedAt: e.kioskPin?.lastUsedAt ?? null,
      locked: locks[i] === 1,
    }));
  }

  /** Throws the 429 `KIOSK_LOCKED` response if this employee's PIN is currently locked out. */
  async assertNotLocked(employeeId: string): Promise<void> {
    const ttl = await this.redis.ttl(lockKey(employeeId));
    if (ttl > 0) {
      throw new HttpException(
        {
          statusCode: 429,
          error: 'Too Many Requests',
          code: KIOSK_ERROR.LOCKED,
          message: 'Too many incorrect attempts. Try again later or ask HR to reset your PIN.',
          retryAfterSeconds: ttl,
        },
        429,
      );
    }
  }

  /** `true` iff `pin` matches the employee's stored PIN. Always spends one argon2 verify, found or not. */
  async verify(
    tx: Prisma.TransactionClient,
    employeeId: string | null,
    pin: string,
  ): Promise<boolean> {
    const row = employeeId ? await tx.employeeKioskPin.findFirst({ where: { employeeId } }) : null;
    if (!row) {
      await this.hashing.verify(await this.getDummyHash(), pin).catch(() => false);
      return false;
    }
    return this.hashing.verify(row.pinHash, pin);
  }

  async markUsed(tx: Prisma.TransactionClient, employeeId: string): Promise<void> {
    await tx.employeeKioskPin.updateMany({
      where: { employeeId },
      data: { lastUsedAt: new Date() },
    });
    await this.redis.del(failKey(employeeId));
  }

  /**
   * Counts a wrong PIN against the employee and returns whether this attempt tripped the lockout.
   * Lives in REDIS, never the database: the identify request that records the failure ends in a 401, which
   * rolls back the whole request transaction — a DB counter would be rolled back with it and the lockout
   * would never trip.
   */
  async recordFailure(employeeId: string): Promise<{ locked: boolean }> {
    const count = await this.redis.incr(failKey(employeeId));
    if (count === 1) {
      await this.redis.expire(failKey(employeeId), PIN_LOCK_SECONDS);
    }
    if (count >= PIN_MAX_FAILURES) {
      await this.redis.set(lockKey(employeeId), '1', 'EX', PIN_LOCK_SECONDS);
      await this.redis.del(failKey(employeeId));
      return { locked: true };
    }
    return { locked: false };
  }

  private getDummyHash(): Promise<string> {
    this.dummyHash ??= this.hashing.hash('000000');
    return this.dummyHash;
  }

  private async requireEmployee(
    tx: Prisma.TransactionClient,
    employeeId: string,
    allowedBranchIds: string[] | null,
  ) {
    const employee = await tx.employee.findUnique({
      where: { id: employeeId },
      select: {
        id: true,
        employeeCode: true,
        firstName: true,
        lastName: true,
        branchId: true,
        status: true,
      },
    });
    if (!employee || (allowedBranchIds && !allowedBranchIds.includes(employee.branchId))) {
      throw new NotFoundException(`Employee "${employeeId}" was not found.`);
    }
    return employee;
  }
}
