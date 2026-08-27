import { SetMetadata } from '@nestjs/common';

export const IDEMPOTENT_KEY = 'hrm:idempotent';

/**
 * Marks a route as requiring an `Idempotency-Key` header — paired with
 * `@UseInterceptors(IdempotencyInterceptor)`, same "decorator carries
 * metadata, a route-scoped interceptor does the work" shape as
 * `@AuditLog()`/`AuditInterceptor`. A request missing the header on an
 * `@Idempotent()` route is a `400`; one presenting a KEY already recorded
 * `COMPLETED` gets the cached result back without re-running the handler.
 */
export const Idempotent = () => SetMetadata(IDEMPOTENT_KEY, true);
