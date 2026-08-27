import { Global, Module } from '@nestjs/common';
import { AuditCaptureService } from './audit-capture.service';
import { AuditInterceptor } from './audit.interceptor';
import { AuditRecordService } from './audit-record.service';
import { AuditQueryService } from './audit-query.service';
import { AuditController } from './audit.controller';
import { DomainEventAuditListener } from './listeners/domain-event-audit.listener';

/**
 * The audit log (step 0.9) — see /CLAUDE.md § Conventions → Audit log.
 * `@Global()`, same reasoning `TenancyModule` documents for itself:
 * `AuditInterceptor` is meant to be used via `@UseInterceptors(AuditInterceptor)`
 * from ANY controller (`country-packs.controller.ts`,
 * `custom-fields.controller.ts`, future ones), and unlike `PermissionsGuard`
 * (whose own dependencies — `Reflector`, and `TenantContextService` from
 * the already-`@Global()` `TenancyModule` — happen to be globally available
 * regardless of which module registers `PermissionsGuard` itself),
 * `AuditInterceptor` depends on `AuditRecordService`, which has no other
 * global source — without `@Global()` here, Nest can only resolve it
 * inside `AuditModule`'s own context, which breaks the instant a consuming
 * controller lives in a module that doesn't import this one.
 */
@Global()
@Module({
  controllers: [AuditController],
  providers: [AuditRecordService, AuditCaptureService, AuditInterceptor, AuditQueryService, DomainEventAuditListener],
  exports: [AuditRecordService, AuditCaptureService, AuditInterceptor],
})
export class AuditModule {}
