import { Module } from '@nestjs/common';
import { PlatformAuthContextService } from './platform-auth-context.service';
import { PlatformTokenService } from './platform-token.service';

/**
 * A small LEAF module (no imports of its own — `ConfigService`/
 * `REDIS_CLIENT` are both already global), imported by `TenancyModule` so
 * `TenantScopeInterceptor` can authenticate a `@PlatformRoute()` request.
 * Deliberately NOT the same module as the bigger `PlatformModule` (login,
 * MFA enrollment, tenant lifecycle, ...) — that one needs a working
 * `TenantScopeInterceptor` already wired (its own controllers are
 * `@PlatformRoute()`), this one runs BEFORE any of that exists for the
 * request. Identical shape to `ApiKeyAuthModule` — see that file's own
 * doc comment.
 */
@Module({
  providers: [PlatformTokenService, PlatformAuthContextService],
  exports: [PlatformTokenService, PlatformAuthContextService],
})
export class PlatformAuthContextModule {}
