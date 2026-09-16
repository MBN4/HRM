import { Global, Module } from '@nestjs/common';
import { CorsOriginService } from './cors-origin.service';

/**
 * `@Global()` — `CorsOriginService` is resolved once in `main.ts` (before
 * any request-scoped DI even applies, since `app.enableCors()`'s origin
 * callback runs as plain middleware) via `app.get(CorsOriginService)`, the
 * same "grab a singleton off the root injector at bootstrap" pattern
 * `main.ts` already uses for `MetricsService`/`ShutdownService`.
 *
 * `CacheControlInterceptor` (step 6.3) is deliberately NOT registered
 * here as a global provider — it's used purely via
 * `@UseInterceptors(CacheControlInterceptor)` at each cacheable route
 * (see `CareersController`), the same "no explicit provider registration
 * needed, `Reflector` is always globally resolvable" posture
 * `PermissionsGuard` already establishes for itself (see
 * `AuditModule`'s own doc comment contrasting the two).
 */
@Global()
@Module({
  providers: [CorsOriginService],
  exports: [CorsOriginService],
})
export class SecurityModule {}
