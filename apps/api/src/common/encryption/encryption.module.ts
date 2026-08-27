import { Global, Module } from '@nestjs/common';
import { EncryptionService } from './encryption.service';

/**
 * `@Global()`, same reasoning `AuditModule`/`TenancyModule` document for
 * themselves: `EncryptionService` is a general-purpose primitive (today
 * used by `EmployeeModule` for bank/salary fields) any future
 * PII-adjacent module should reuse rather than reimplementing its own
 * encrypt-at-rest helper — see docs/conventions/employee.md.
 */
@Global()
@Module({
  providers: [EncryptionService],
  exports: [EncryptionService],
})
export class EncryptionModule {}
