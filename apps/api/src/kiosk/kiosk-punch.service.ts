import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { Employee, Prisma } from '@hrm/db';
import type {
  KioskAction,
  KioskBiometricIdentifyInput,
  KioskClockInput,
  KioskIdentifyInput,
} from '@hrm/shared';
import { AuditRecordService } from '../audit/audit-record.service';
import { toBranchLocal } from '../attendance/attendance-timezone.util';
import { ALREADY_CLOCKED_IN_MESSAGE } from '../attendance/attendance.constants';
import {
  AttendanceClockService,
  UploadedPhoto,
} from '../attendance/clock/attendance-clock.service';
import {
  BIOMETRIC_DEVICE_ADAPTER,
  BiometricDeviceAdapter,
} from '../attendance/devices/biometric-device.interface';
import { AttendanceStatusService } from '../attendance/status/attendance-status.service';
import type { ClassifiedDay } from '../attendance/status/attendance-day-classifier';
import { REDIS_CLIENT } from '../redis/redis.constants';
import type { RequestTenantStore } from '../tenancy/tenant-context.store';
import {
  KIOSK_ERROR,
  KIOSK_FAILURE_WINDOW_SECONDS,
  KIOSK_IDENTIFY_PER_MINUTE,
  KIOSK_MAX_FAILURES_PER_WINDOW,
  KIOSK_PHOTO_MIME_TYPES,
  MAX_KIOSK_PHOTO_BYTES,
} from './kiosk.constants';
import { KioskPinService } from './kiosk-pin.service';
import { KioskTicketService } from './kiosk-ticket.service';

type KioskIdentity = NonNullable<RequestTenantStore['kiosk']>;

export interface KioskRequestMeta {
  ip: string | null;
  userAgent: string | null;
}

export interface KioskEmployeeState {
  openSince: string | null;
  lastClockOutAt: string | null;
  suggestedAction: KioskAction;
  /** Today's classification (the 8.1 attendance-status engine) — null if it cannot be computed. */
  today: Pick<
    ClassifiedDay,
    'status' | 'reason' | 'isLate' | 'minutesLate' | 'hoursWorked' | 'expectedStartTime'
  > | null;
}

const identifyRateKey = (kioskId: string) => `kiosk:identify:${kioskId}`;
const kioskFailKey = (kioskId: string) => `kiosk:fail:${kioskId}`;

/**
 * Identify-and-clock — the ONLY things a kiosk device can do. It deliberately contains no attendance
 * logic of its own: a punch is `AttendanceClockService.clockInForEmployee/clockOutForEmployee` with
 * source `KIOSK`, so it lands in the same `attendance_records` table and flows through shift resolution,
 * day attribution, overtime/lateness, classification, the summary rollup and payroll exactly like a
 * web/mobile punch.
 *
 * Every query runs inside the request's RLS-scoped transaction (tenant isolation) and the branch fence
 * is enforced HERE, in the lookup itself: an employee of another branch is simply not found.
 */
@Injectable()
export class KioskPunchService {
  private readonly logger = new Logger(KioskPunchService.name);

  constructor(
    private readonly pins: KioskPinService,
    private readonly tickets: KioskTicketService,
    private readonly attendanceClock: AttendanceClockService,
    private readonly status: AttendanceStatusService,
    private readonly audit: AuditRecordService,
    @Inject(BIOMETRIC_DEVICE_ADAPTER) private readonly biometric: BiometricDeviceAdapter,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  /** Step 1 — verify employee code + PIN, hand back a short-lived ticket plus what the screen shows. */
  async identify(
    tx: Prisma.TransactionClient,
    tenantId: string,
    kiosk: KioskIdentity,
    input: KioskIdentifyInput,
    meta: KioskRequestMeta,
  ) {
    await this.assertKioskNotThrottled(kiosk.id);

    // Branch fence in the query itself: another branch's (or tenant's) employee is "not found".
    const employee = await tx.employee.findFirst({
      where: { employeeCode: input.employeeCode, branchId: kiosk.branchId, status: 'ACTIVE' },
    });

    if (employee) {
      await this.pins.assertNotLocked(employee.id);
    }
    const ok = await this.pins.verify(tx, employee?.id ?? null, input.pin);
    if (!employee || !ok) {
      const locked = employee ? (await this.pins.recordFailure(employee.id)).locked : false;
      await this.recordKioskFailure(
        tenantId,
        kiosk,
        input.employeeCode,
        employee ? 'WRONG_PIN' : 'UNKNOWN_EMPLOYEE',
        meta,
        locked,
      );
      throw new UnauthorizedException({
        statusCode: 401,
        error: 'Unauthorized',
        code: KIOSK_ERROR.INVALID_CREDENTIALS,
        message: 'Employee ID or PIN is incorrect.',
      });
    }

    await this.pins.markUsed(tx, employee.id);
    return this.identified(tx, tenantId, kiosk, employee, 'PIN');
  }

  /** Optional step 1 for hardware-backed kiosks: the device's reader vouches for the employee (see doc § trust model). */
  async identifyBiometric(
    tx: Prisma.TransactionClient,
    tenantId: string,
    kiosk: KioskIdentity,
    input: KioskBiometricIdentifyInput,
    meta: KioskRequestMeta,
  ) {
    if (!kiosk.biometricEnabled) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        code: KIOSK_ERROR.BIOMETRIC_DISABLED,
        message: 'Biometric identification is not enabled for this kiosk.',
      });
    }
    await this.assertKioskNotThrottled(kiosk.id);
    const employee = await tx.employee.findFirst({
      where: { employeeCode: input.employeeCode, branchId: kiosk.branchId, status: 'ACTIVE' },
    });
    if (!employee) {
      await this.recordKioskFailure(
        tenantId,
        kiosk,
        input.employeeCode,
        'UNKNOWN_EMPLOYEE',
        meta,
        false,
      );
      throw new UnauthorizedException({
        statusCode: 401,
        error: 'Unauthorized',
        code: KIOSK_ERROR.INVALID_CREDENTIALS,
        message: 'Employee was not recognised.',
      });
    }
    return this.identified(tx, tenantId, kiosk, employee, 'BIOMETRIC');
  }

  /** Step 2 — redeem a ticket into a real clock-in/out. */
  async punch(
    tx: Prisma.TransactionClient,
    tenantId: string,
    kiosk: KioskIdentity,
    input: KioskClockInput,
    photo: UploadedPhoto | undefined,
    meta: KioskRequestMeta,
  ) {
    const claims = this.tickets.verify(input.ticket);
    if (claims.t !== tenantId || claims.k !== kiosk.id) {
      // A ticket minted by a DIFFERENT device (or tenant) is worthless here.
      throw this.tickets.invalidTicket();
    }

    // Re-check at redemption: the employee may have been terminated or moved branch since identify.
    const employee = await tx.employee.findFirst({
      where: { id: claims.e, branchId: kiosk.branchId, status: 'ACTIVE' },
    });
    if (!employee) {
      throw new UnauthorizedException({
        statusCode: 401,
        error: 'Unauthorized',
        code: KIOSK_ERROR.INVALID_CREDENTIALS,
        message: 'This employee can no longer clock in at this kiosk.',
      });
    }

    if (photo) {
      if (
        !KIOSK_PHOTO_MIME_TYPES.includes(photo.mimeType) ||
        photo.buffer.length > MAX_KIOSK_PHOTO_BYTES
      ) {
        throw new BadRequestException({
          statusCode: 400,
          error: 'Bad Request',
          code: KIOSK_ERROR.PHOTO_INVALID,
          message: 'The photo must be a JPEG, PNG or WebP image under 5 MB.',
        });
      }
    } else if (kiosk.requirePhoto) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        code: KIOSK_ERROR.PHOTO_REQUIRED,
        message: 'This kiosk requires a photo for every punch.',
      });
    }

    const open = await tx.attendanceRecord.findFirst({
      where: { employeeId: employee.id, status: 'OPEN' },
      select: { id: true },
    });
    if (input.action === 'IN' && open) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        code: KIOSK_ERROR.ALREADY_CLOCKED_IN,
        message: ALREADY_CLOCKED_IN_MESSAGE,
      });
    }
    if (input.action === 'OUT' && !open) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        code: KIOSK_ERROR.NOT_CLOCKED_IN,
        message: 'You are not clocked in.',
      });
    }

    const record =
      claims.m === 'BIOMETRIC'
        ? await this.punchViaBiometricSeam(tx, tenantId, kiosk, employee, input.action)
        : input.action === 'IN'
          ? await this.attendanceClock.clockInForEmployee(
              tx,
              tenantId,
              employee,
              'KIOSK',
              undefined,
              undefined,
              photo,
              kiosk.id,
            )
          : await this.attendanceClock.clockOutForEmployee(
              tx,
              tenantId,
              employee,
              'KIOSK',
              undefined,
              undefined,
              photo,
              kiosk.id,
            );

    await this.audit.recordWithinTransaction(tx, {
      tenantId,
      actor: { userId: null, platform: false },
      action: input.action === 'IN' ? 'KIOSK_CLOCK_IN' : 'KIOSK_CLOCK_OUT',
      entityType: 'AttendanceRecord',
      entityId: record.id,
      after: {
        id: record.id,
        status: record.status,
        workedMinutes: record.workedMinutes,
        lateMinutes: record.lateMinutes,
      },
      metadata: {
        kioskId: kiosk.id,
        kioskName: kiosk.name,
        branchId: kiosk.branchId,
        employeeId: employee.id,
        employeeCode: employee.employeeCode,
        method: claims.m,
        photo: Boolean(photo),
        ip: meta.ip,
        userAgent: meta.userAgent,
      },
    });

    return {
      action: input.action,
      record,
      employee: this.displayEmployee(employee),
      state: await this.employeeState(tx, tenantId, employee),
    };
  }

  /** Today's state for one employee — what the screen shows after identify and after a punch. */
  async employeeState(
    tx: Prisma.TransactionClient,
    tenantId: string,
    employee: Employee,
  ): Promise<KioskEmployeeState> {
    const open = await tx.attendanceRecord.findFirst({
      where: { employeeId: employee.id, status: 'OPEN' },
      orderBy: { clockInAt: 'desc' },
    });
    const branch = await tx.branch.findUnique({
      where: { id: employee.branchId },
      select: { timezone: true },
    });

    let lastClockOutAt: string | null = null;
    let today: KioskEmployeeState['today'] = null;
    if (branch) {
      const now = new Date();
      const ymd = toBranchLocal(now, branch.timezone).calendarDate.toISOString().slice(0, 10);
      const lastClosed = await tx.attendanceRecord.findFirst({
        where: {
          employeeId: employee.id,
          status: 'CLOSED',
          workDate: new Date(`${ymd}T00:00:00.000Z`),
        },
        orderBy: { clockOutAt: 'desc' },
        select: { clockOutAt: true },
      });
      lastClockOutAt = lastClosed?.clockOutAt?.toISOString() ?? null;
      try {
        const result = await this.status.classifyRange(
          tx,
          tenantId,
          {
            userId: 'kiosk',
            branchIds: [employee.branchId],
            canReadTenant: true,
            canReadReports: false,
          },
          { employeeId: employee.id, from: ymd, to: ymd },
          now,
        );
        const day = result.days[0];
        if (day) {
          today = {
            status: day.status,
            reason: day.reason,
            isLate: day.isLate,
            minutesLate: day.minutesLate,
            hoursWorked: day.hoursWorked,
            expectedStartTime: day.expectedStartTime,
          };
        }
      } catch (error) {
        // The classification is a nicety on the confirmation screen — never block a punch on it.
        this.logger.warn(`Could not classify today for employee ${employee.id}: ${String(error)}`);
      }
    }
    return {
      openSince: open?.clockInAt.toISOString() ?? null,
      lastClockOutAt,
      suggestedAction: open ? 'OUT' : 'IN',
      today,
    };
  }

  private async identified(
    tx: Prisma.TransactionClient,
    tenantId: string,
    kiosk: KioskIdentity,
    employee: Employee,
    method: 'PIN' | 'BIOMETRIC',
  ) {
    const { ticket, expiresInSeconds } = this.tickets.sign({
      t: tenantId,
      k: kiosk.id,
      e: employee.id,
      m: method,
    });
    return {
      ticket,
      expiresInSeconds,
      requirePhoto: kiosk.requirePhoto,
      employee: this.displayEmployee(employee),
      state: await this.employeeState(tx, tenantId, employee),
    };
  }

  /** The 1.3 biometric seam does the punch (source BIOMETRIC); we then stamp which kiosk captured it. */
  private async punchViaBiometricSeam(
    tx: Prisma.TransactionClient,
    tenantId: string,
    kiosk: KioskIdentity,
    employee: Employee,
    action: KioskAction,
  ) {
    const record = await this.biometric.handlePunch(tx, tenantId, {
      employeeCode: employee.employeeCode,
      direction: action,
      deviceId: kiosk.id,
    });
    await tx.attendanceRecord.update({
      where: { id_workDate: { id: record.id, workDate: new Date(record.workDate) } },
      data: action === 'IN' ? { clockInKioskId: kiosk.id } : { clockOutKioskId: kiosk.id },
    });
    return record;
  }

  private displayEmployee(employee: Employee) {
    return {
      employeeCode: employee.employeeCode,
      firstName: employee.firstName,
      lastName: employee.lastName,
    };
  }

  /** Refuses further identify attempts from a device that is guessing too much, before spending an argon2 verify. */
  private async assertKioskNotThrottled(kioskId: string): Promise<void> {
    const perMinute = await this.redis.incr(identifyRateKey(kioskId));
    if (perMinute === 1) {
      await this.redis.expire(identifyRateKey(kioskId), 60);
    }
    const failures = Number((await this.redis.get(kioskFailKey(kioskId))) ?? 0);
    if (perMinute > KIOSK_IDENTIFY_PER_MINUTE || failures >= KIOSK_MAX_FAILURES_PER_WINDOW) {
      const ttl = await this.redis.ttl(
        failures >= KIOSK_MAX_FAILURES_PER_WINDOW
          ? kioskFailKey(kioskId)
          : identifyRateKey(kioskId),
      );
      throw new HttpException(
        {
          statusCode: 429,
          error: 'Too Many Requests',
          code: KIOSK_ERROR.LOCKED,
          message: 'Too many attempts on this kiosk. Please wait and try again.',
          retryAfterSeconds: Math.max(ttl, 1),
        },
        429,
      );
    }
  }

  /**
   * Failed identifies are audited via `recordForTenant` (its OWN transaction) and counted in Redis — both
   * deliberately outside the request transaction, which the 401 that follows rolls back.
   */
  private async recordKioskFailure(
    tenantId: string,
    kiosk: KioskIdentity,
    attemptedCode: string,
    reason: string,
    meta: KioskRequestMeta,
    locked: boolean,
  ): Promise<void> {
    const count = await this.redis.incr(kioskFailKey(kiosk.id));
    if (count === 1) {
      await this.redis.expire(kioskFailKey(kiosk.id), KIOSK_FAILURE_WINDOW_SECONDS);
    }
    await this.audit.recordForTenant({
      tenantId,
      actor: { userId: null, platform: false },
      action: locked ? 'KIOSK_PIN_LOCKED' : 'KIOSK_IDENTIFY_FAILED',
      entityType: 'Kiosk',
      entityId: kiosk.id,
      metadata: {
        kioskId: kiosk.id,
        kioskName: kiosk.name,
        branchId: kiosk.branchId,
        attemptedEmployeeCode: attemptedCode.slice(0, 64),
        reason,
        ip: meta.ip,
        userAgent: meta.userAgent,
      },
    });
  }
}
