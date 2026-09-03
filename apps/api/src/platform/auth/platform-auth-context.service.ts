import { Injectable } from '@nestjs/common';
import { prisma } from '@hrm/db';
import type { PlatformRoleNameKey } from '@hrm/shared';
import { PlatformTokenService } from './platform-token.service';

export interface AuthenticatedPlatformAdmin {
  platformAdminId: string;
  role: PlatformRoleNameKey;
}

/**
 * The interceptor-facing half of platform authentication — deliberately
 * separate from `PlatformAuthService` (login/MFA orchestration, in the
 * bigger `PlatformModule`), the SAME "authenticate vs. manage" split
 * `ApiKeyAuthService` vs. the rest of API-key management already
 * establishes (see docs/conventions/integrations.md). `TenantScopeInterceptor`
 * calls THIS on every `@PlatformRoute()` request (see
 * platform-auth-context.module.ts for why it lives in its own leaf
 * module).
 *
 * Queries the OWNER `prisma` client directly, by construction: a platform
 * request opens no tenant-scoped transaction to query through (see
 * docs/conventions/tenant-resolution.md → Platform context) —
 * `PlatformAdmin` isn't tenant-scoped in the first place.
 */
@Injectable()
export class PlatformAuthContextService {
  constructor(private readonly tokens: PlatformTokenService) {}

  async authenticate(rawToken: string): Promise<AuthenticatedPlatformAdmin | null> {
    let payload;
    try {
      payload = this.tokens.verifyAccessToken(rawToken);
    } catch {
      return null;
    }

    const admin = await prisma.platformAdmin.findUnique({ where: { id: payload.sub } });
    if (!admin || admin.status !== 'ACTIVE') {
      return null;
    }
    // A role change since this token was issued takes effect immediately —
    // the same "never trust a stale claim" posture 0.4's own tenant
    // PermissionsGuard already holds itself to (permissions are loaded
    // fresh every request, never trusted from the token).
    if (admin.role !== payload.role) {
      return null;
    }
    // Mandatory MFA, re-checked here too (not just at login): an admin
    // whose MFA was somehow disabled after a token was issued (e.g. a
    // PLATFORM_OWNER support action, or direct DB intervention) loses
    // platform access immediately rather than riding out the token's TTL.
    if (!admin.mfaEnabled) {
      return null;
    }

    return { platformAdminId: admin.id, role: admin.role };
  }
}
