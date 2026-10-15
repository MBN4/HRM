import { Module } from '@nestjs/common';
import { AttendanceModule } from '../attendance/attendance.module';
import { KioskAdminController } from './kiosk-admin.controller';
import { KioskDeviceController } from './kiosk-device.controller';
import { KioskPinService } from './kiosk-pin.service';
import { KioskPunchService } from './kiosk-punch.service';
import { KioskTicketService } from './kiosk-ticket.service';
import { KioskService } from './kiosk.service';

/**
 * Kiosk mode (step 11.1) — a shared attendance terminal. A pure CONSUMER of the attendance module
 * (`AttendanceClockService`, `AttendanceStatusService`, and the biometric seam token — all already
 * exported): there is no attendance logic in here. Device AUTHENTICATION lives in the tenancy layer
 * (`auth/kiosk/`, called from `TenantScopeInterceptor`), not in this module. See docs/conventions/kiosk.md.
 */
@Module({
  imports: [AttendanceModule],
  controllers: [KioskAdminController, KioskDeviceController],
  providers: [KioskService, KioskPinService, KioskPunchService, KioskTicketService],
})
export class KioskModule {}
