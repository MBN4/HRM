import { Module } from '@nestjs/common';
import { ApiKeyAuthService } from './api-key-auth.service';
import { ApiKeyRateLimitService } from './api-key-rate-limit.service';

/**
 * A small LEAF module (no imports of its own — `HashingService`/
 * `RateLimiterService` are both already `@Global()`), imported by
 * `TenancyModule` so `TenantScopeInterceptor` can authenticate an API-key
 * request. Deliberately NOT the same module as the tenant-facing
 * `ApiKeysModule` (create/revoke/list, under `apps/api/src/integrations/`)
 * — that one needs a normal tenant-scoped request transaction and RBAC,
 * this one runs BEFORE any of that exists for the request, the same
 * "authenticate vs. manage" split `AuthProvider.validate` vs. the rest of
 * `AuthService` already takes.
 */
@Module({
  providers: [ApiKeyAuthService, ApiKeyRateLimitService],
  exports: [ApiKeyAuthService, ApiKeyRateLimitService],
})
export class ApiKeyAuthModule {}
