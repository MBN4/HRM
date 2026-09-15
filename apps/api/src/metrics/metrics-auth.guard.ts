import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';

/**
 * Phase 5.4 — `GET /metrics` is `@Public()` (no tenant/user context makes
 * sense for an infra scrape endpoint), so it needs its OWN, separate
 * gate — a plain `CanActivate` guard is fine here (unlike
 * `PermissionsGuard`, which HAS to be an interceptor because it depends on
 * context `TenantScopeInterceptor` sets up during its own interceptor
 * phase — see docs/conventions/auth-rbac.md) since this guard depends on
 * nothing but the raw request header.
 *
 * `METRICS_TOKEN` unset -> ALLOW (the same "no setup needed for local dev"
 * default this codebase already uses for e.g. `PLATFORM_MODE_ENABLED`),
 * but this is a REAL exposure if left unset in any non-local environment
 * — defense-in-depth is expected ALONGSIDE this (a NetworkPolicy/ingress
 * rule restricting `/metrics` to the cluster's own monitoring namespace,
 * see deploy/observability/README.md), not instead of it, the same
 * "no single layer trusted alone" posture this codebase applies
 * everywhere else.
 */
@Injectable()
export class MetricsAuthGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const token = this.config.get<string>('METRICS_TOKEN');
    if (!token) {
      return true;
    }
    const req = context.switchToHttp().getRequest<Request>();
    const header = req.headers.authorization;
    const presented = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
    if (presented !== token) {
      throw new UnauthorizedException('A valid metrics token is required.');
    }
    return true;
  }
}
