import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { instanceToPlain } from 'class-transformer';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { TenantContextService } from '../../tenancy/tenant-context.service';

/**
 * Applies `@RequiresPermission()` field gating to a route's response.
 * Reads the current request's permission set from `TenantContextService`
 * and passes it as `class-transformer`'s serialization `groups` — fields
 * without a `@RequiresPermission()` are untouched; fields with one are
 * dropped unless the user holds that permission.
 *
 * Only affects real class instances (e.g. `new SomeDto(...)` or
 * `plainToInstance(SomeDto, row)`) — a plain object with no
 * `class-transformer` metadata passes through unchanged, since there's
 * nothing to gate. Apply per-route (`@UseInterceptors(...)`), not
 * globally: most routes return plain data with nothing sensitive to gate.
 */
@Injectable()
export class PermissionSerializerInterceptor implements NestInterceptor {
  constructor(private readonly tenantContext: TenantContextService) {}

  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      map((data) => {
        const permissions = this.tenantContext.getStore()?.permissions ?? [];
        if (Array.isArray(data)) {
          return data.map((item) => this.serialize(item, permissions));
        }
        return this.serialize(data, permissions);
      }),
    );
  }

  private serialize(item: unknown, permissions: string[]): unknown {
    if (item === null || typeof item !== 'object') {
      return item;
    }
    return instanceToPlain(item, { groups: permissions, excludeExtraneousValues: false });
  }
}
