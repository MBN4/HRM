import { BadRequestException, CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { firstValueFrom, from, Observable } from 'rxjs';
import { idempotencyKeySchema } from '@hrm/shared';
import { TenantContextService } from '../../tenancy/tenant-context.service';
import { IDEMPOTENT_KEY } from './idempotent.decorator';
import { IdempotencyService } from './idempotency.service';

/**
 * Enforces `@Idempotent()` — see that decorator and `IdempotencyService`
 * for the full write-up. Same "route-scoped interceptor needs
 * `TenantContextService`, which only works once `TenantScopeInterceptor`'s
 * interceptor-phase context is open" shape as `AuditInterceptor`. Scopes
 * the idempotency key per TENANT (so two different tenants coincidentally
 * choosing the same client-generated key never collide) — falls back to
 * `"platform"` for the (rare) `@Idempotent()` route with no tenant
 * context, so the mechanism still works there instead of throwing.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly idempotency: IdempotencyService,
    private readonly tenantContext: TenantContextService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const isIdempotent = this.reflector.getAllAndOverride<boolean>(IDEMPOTENT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!isIdempotent || context.getType() !== 'http') {
      return next.handle();
    }

    const req = context.switchToHttp().getRequest<Request>();
    const header = req.headers['idempotency-key'];
    const rawKey = Array.isArray(header) ? header[0] : header;
    const parsed = idempotencyKeySchema.safeParse(rawKey);
    if (!parsed.success) {
      throw new BadRequestException(
        'This route requires an Idempotency-Key header (a client-generated token, 8-255 characters).',
      );
    }

    const scope = this.tenantContext.getContext().tenantId ?? 'platform';
    return from(this.idempotency.execute(scope, parsed.data, () => firstValueFrom(next.handle())));
  }
}
