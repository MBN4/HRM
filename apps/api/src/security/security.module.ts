import { Global, Module } from '@nestjs/common';
import { CorsOriginService } from './cors-origin.service';

/**
 * `@Global()` — `CorsOriginService` is resolved once in `main.ts` (before
 * any request-scoped DI even applies, since `app.enableCors()`'s origin
 * callback runs as plain middleware) via `app.get(CorsOriginService)`, the
 * same "grab a singleton off the root injector at bootstrap" pattern
 * `main.ts` already uses for `MetricsService`/`ShutdownService`.
 */
@Global()
@Module({
  providers: [CorsOriginService],
  exports: [CorsOriginService],
})
export class SecurityModule {}
