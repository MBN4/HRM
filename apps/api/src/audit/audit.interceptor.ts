import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { concatMap, Observable } from 'rxjs';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { AuditCaptureFrame, auditCaptureStorage } from './audit-capture.store';
import { AUDIT_LOG_KEY, AuditLogMetadata } from './audit-log.decorator';
import { AuditRecordService } from './audit-record.service';

function extractEntityId(result: unknown, req: Request): string | null {
  if (result && typeof result === 'object' && 'id' in result && typeof (result as { id: unknown }).id === 'string') {
    return (result as { id: string }).id;
  }
  const paramId = req.params?.id;
  return typeof paramId === 'string' ? paramId : null;
}

/**
 * Automatic HTTP-mutation audit capture — see /CLAUDE.md § Conventions →
 * Audit log. Applied via `@UseInterceptors(AuditInterceptor)` +
 * `@AuditLog(entityType, action)`, the SAME "route-scoped interceptor
 * reads metadata a global interceptor couldn't have populated in time"
 * shape as `PermissionsGuard`/`FeatureFlagGuard` (see those files for why
 * this is an interceptor, not a `CanActivate` guard — identical reasoning
 * applies here: `TenantContextService.getTx()` only works once
 * `TenantScopeInterceptor`'s interceptor-phase transaction is open).
 *
 * Opens its own `auditCaptureStorage` frame around `next.handle()` so a
 * handler can optionally call `AuditCaptureService.setBefore()` deep in
 * its own execution (see audit-capture.store.ts for why this is a
 * separate `AsyncLocalStorage`, not an extension of the tenancy one), then
 * AWAITS the audit write — inside the request's own transaction — before
 * letting the response through. This deliberately ties the audit row's
 * fate to the mutation's own transaction (a rollback rolls back the audit
 * entry too) and guarantees the entry exists by the time the caller sees
 * a response, unlike the domain-event sink's necessarily fire-and-forget
 * write (see AuditRecordService.recordForTenant).
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly tenantContext: TenantContextService,
    private readonly auditRecord: AuditRecordService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const metadata = this.reflector.getAllAndOverride<AuditLogMetadata | undefined>(AUDIT_LOG_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!metadata || context.getType() !== 'http') {
      return next.handle();
    }

    const req = context.switchToHttp().getRequest<Request>();
    const frame: AuditCaptureFrame = { before: null };

    return auditCaptureStorage.run(frame, () =>
      next.handle().pipe(
        concatMap(async (result: unknown) => {
          const tenantId = this.tenantContext.getContext().tenantId;
          if (!tenantId) {
            return result;
          }

          await this.auditRecord.recordWithinTransaction(this.tenantContext.getTx(), {
            tenantId,
            actor: { userId: this.tenantContext.userId, platform: this.tenantContext.isPlatform },
            action: metadata.action,
            entityType: metadata.entityType,
            entityId: extractEntityId(result, req),
            before: frame.before,
            after: result,
            metadata: {
              method: req.method,
              path: req.originalUrl ?? req.url,
              ip: req.ip ?? null,
              userAgent: req.headers['user-agent'] ?? null,
              // Step 4.1 — LOUDLY tags every action taken during a
              // support impersonation session with the REAL platform
              // admin's id, never just the impersonated tenant user's —
              // see docs/conventions/vendor-console.md → Impersonation.
              // Null for every ordinary (non-impersonated) request.
              impersonatedByPlatformAdminId: this.tenantContext.impersonatedByPlatformAdminId,
            },
          });

          return result;
        }),
      ),
    );
  }
}
