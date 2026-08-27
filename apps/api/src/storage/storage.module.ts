import { Global, Module } from '@nestjs/common';
import { StorageService } from './storage.service';

/**
 * `@Global()`, same reasoning `EncryptionModule`/`QueueModule` document for
 * themselves — `StorageService` is meant to be reused as-is by any future
 * module needing object storage (payslip exports, report generation, ...),
 * not reimplemented per module. See storage.service.ts and
 * docs/conventions/employee.md.
 */
@Global()
@Module({
  providers: [StorageService],
  exports: [StorageService],
})
export class StorageModule {}
