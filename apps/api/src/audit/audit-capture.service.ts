import { Injectable } from '@nestjs/common';
import { auditCaptureStorage } from './audit-capture.store';

/**
 * Optional, per-request hook a mutating route handler calls with the
 * pre-mutation state of the row it's about to change (e.g. the existing
 * `TenantCountryOverride` before an upsert) — `AuditInterceptor` reads it
 * back as the audit row's `before` field. Calling this is OPTIONAL: a
 * `CREATE`-style route has nothing to capture (before = null is correct),
 * and `@AuditLog()` routes work without ever calling this — `after` alone
 * (the handler's redacted response) still gets recorded automatically.
 * A no-op outside an `@AuditLog()`-decorated request (no storage frame
 * open), so a service method can call this unconditionally without caring
 * whether the current route is even being audited.
 */
@Injectable()
export class AuditCaptureService {
  setBefore(value: unknown): void {
    const frame = auditCaptureStorage.getStore();
    if (frame) {
      frame.before = value;
    }
  }
}
