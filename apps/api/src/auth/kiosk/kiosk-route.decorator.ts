import { SetMetadata } from '@nestjs/common';

export const IS_KIOSK_ROUTE_KEY = 'hrm:isKioskRoute';

/**
 * Marks a route as one a KIOSK DEVICE may call — and, equally important, as ONE THAT ONLY A KIOSK
 * DEVICE MAY CALL. `TenantScopeInterceptor` enforces both directions:
 *
 *   - a `@KioskRoute()` handler requires a valid `X-Kiosk-Token` (a JWT or API key is NOT accepted),
 *   - every OTHER route rejects a request carrying `X-Kiosk-Token` outright (403).
 *
 * So a stolen kiosk token cannot reach a single route that isn't explicitly opted in here, no matter
 * what that route's own RBAC says. See docs/conventions/kiosk.md → "The device trust model".
 */
export const KioskRoute = () => SetMetadata(IS_KIOSK_ROUTE_KEY, true);
