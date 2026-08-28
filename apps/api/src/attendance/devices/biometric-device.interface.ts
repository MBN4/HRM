import type { Prisma } from '@hrm/db';
import type { AttendanceRecordResponseDto } from '../attendance-response.dto';

export const BIOMETRIC_DEVICE_ADAPTER = Symbol('BIOMETRIC_DEVICE_ADAPTER');

export interface BiometricPunchParams {
  /** The device's own employee identifier — resolved against `Employee.employeeCode`, not an internal id (a device has no notion of this system's UUIDs). */
  employeeCode: string;
  direction: 'IN' | 'OUT';
  /** UTC instant the device reports the punch happened — defaults to "now" if the device doesn't report one. */
  timestamp?: Date;
  deviceId: string;
}

/**
 * The biometric/attendance-device seam — the SAME "swap one DI binding, no
 * caller changes" pattern 0.4's `AUTH_PROVIDER` (SSO) and 0.8's
 * `NotificationProvider` seams already establish (see
 * docs/conventions/auth-rbac.md → SSO seam,
 * docs/conventions/notifications-queues.md → Provider seam). No real device
 * protocol exists yet (no vendor SDK, no webhook contract) — this interface
 * only defines the TRANSLATION contract from "a raw punch event" to a real
 * clock-in/out call against `AttendanceClockService`, tagged with source
 * `BIOMETRIC`. Takes an already-open `tx`, the same convention every other
 * service in this codebase follows, exercised today via an authenticated
 * demo route (`POST /attendance/devices/manual-punch`); a real integration
 * (a vendor's push webhook, or a polling agent) implements this interface
 * and is bound in `attendance.module.ts` in place of
 * `ManualBiometricDeviceAdapter` — no other code in this module changes.
 * Such a real integration will likely need its OWN device-authentication
 * story (an API key, not a user JWT) and may need to open its own
 * `withTenantContext` transaction rather than running inside a request's —
 * a documented decision for that future step, not this one.
 */
export interface BiometricDeviceAdapter {
  handlePunch(tx: Prisma.TransactionClient, tenantId: string, params: BiometricPunchParams): Promise<AttendanceRecordResponseDto>;
}
