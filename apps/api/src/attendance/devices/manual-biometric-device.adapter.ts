import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@hrm/db';
import { AttendanceClockService } from '../clock/attendance-clock.service';
import { AttendanceRecordResponseDto } from '../attendance-response.dto';
import { BiometricDeviceAdapter, BiometricPunchParams } from './biometric-device.interface';

/**
 * The dev/manual concrete implementation of the biometric device seam — see
 * biometric-device.interface.ts. Resolves the device's `employeeCode` to a
 * real `Employee`, then delegates straight to `AttendanceClockService`'s
 * lower-level `clockInForEmployee`/`clockOutForEmployee`, tagged with
 * source `BIOMETRIC` — no bespoke attendance logic of its own, exactly the
 * "translate, then reuse the real service" shape this seam exists to prove.
 */
@Injectable()
export class ManualBiometricDeviceAdapter implements BiometricDeviceAdapter {
  constructor(private readonly clock: AttendanceClockService) {}

  async handlePunch(tx: Prisma.TransactionClient, tenantId: string, params: BiometricPunchParams): Promise<AttendanceRecordResponseDto> {
    const employee = await tx.employee.findFirst({ where: { employeeCode: params.employeeCode } });
    if (!employee) {
      throw new NotFoundException(`No employee found with employeeCode "${params.employeeCode}".`);
    }

    if (params.direction === 'IN') {
      return this.clock.clockInForEmployee(tx, tenantId, employee, 'BIOMETRIC');
    }
    return this.clock.clockOutForEmployee(tx, tenantId, employee, 'BIOMETRIC');
  }
}
