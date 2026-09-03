import { Module } from '@nestjs/common';
import { AttendanceModule } from '../../attendance/attendance.module';
import { BiometricDeviceController } from './biometric-device.controller';
import { BiometricDeviceService } from './biometric-device.service';

/** Imports `AttendanceModule` for its now-exported `BIOMETRIC_DEVICE_ADAPTER` token — see that module's doc comment. */
@Module({
  imports: [AttendanceModule],
  controllers: [BiometricDeviceController],
  providers: [BiometricDeviceService],
})
export class BiometricModule {}
