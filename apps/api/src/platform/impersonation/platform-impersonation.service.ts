import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { prisma } from '@hrm/db';
import type { StartImpersonationInput } from '@hrm/shared';
import { AuditRecordService } from '../../audit/audit-record.service';
import { TokenService } from '../../auth/token.service';
import { PlatformAuditRecordService } from '../audit/platform-audit-record.service';

const DEFAULT_IMPERSONATION_MINUTES = 15;
/**
 * Server-side hard ceiling, independent of and stricter than
 * `startImpersonationRequestSchema`'s own 120-minute zod max — a
 * time-boxed support session that could be requested arbitrarily long
 * isn't actually time-boxed. Not configurable via request input; changing
 * it is a deliberate code change, the same posture the country-pack
 * expression evaluator's whitelist takes for itself.
 */
const MAX_IMPERSONATION_MINUTES = 60;

export interface ImpersonationSessionDto {
  id: string;
  tenantId: string;
  targetUserId: string;
  platformAdminId: string;
  reason: string;
  startedAt: string;
  expiresAt: string;
  endedAt: string | null;
  endedReason: string | null;
}

function toDto(row: {
  id: string;
  tenantId: string;
  targetUserId: string;
  platformAdminId: string;
  reason: string;
  startedAt: Date;
  expiresAt: Date;
  endedAt: Date | null;
  endedReason: string | null;
}): ImpersonationSessionDto {
  return {
    id: row.id,
    tenantId: row.tenantId,
    targetUserId: row.targetUserId,
    platformAdminId: row.platformAdminId,
    reason: row.reason,
    startedAt: row.startedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    endedAt: row.endedAt?.toISOString() ?? null,
    endedReason: row.endedReason,
  };
}

/**
 * Support impersonation — designed very carefully per this step's brief:
 * (a) permission-gated (`IMPERSONATION_START`), (b) time-boxed (capped at
 * `MAX_IMPERSONATION_MINUTES`, enforced fresh on EVERY subsequent request
 * by `TenantScopeInterceptor.authenticate()` re-checking the session row,
 * not just trusted from the token's own `exp`), (c) LOUDLY audited — a
 * session start/end is recorded into BOTH `PlatformAuditRecordService`
 * (the vendor's own trail) AND the TARGET TENANT'S OWN `audit_log` (via
 * the existing `AuditRecordService.recordForTenant`, `actorPlatform:
 * true`) so the tenant's own TENANT_ADMIN can see, via their ordinary `GET
 * /audit`, that they were impersonated — this is the "never silent"
 * requirement made concrete: a tenant is not just protected by an
 * assurance impersonation is audited somewhere they can't see, they can
 * see it themselves. Every action the platform admin performs WHILE
 * impersonating is separately tagged via
 * `RequestTenantStore.impersonatedByPlatformAdminId` — see
 * `AuditInterceptor`'s metadata and `TenantScopeInterceptor.authenticate()`.
 */
@Injectable()
export class PlatformImpersonationService {
  constructor(
    private readonly tokens: TokenService,
    private readonly auditRecord: AuditRecordService,
    private readonly platformAudit: PlatformAuditRecordService,
  ) {}

  async start(
    actorId: string,
    tenantId: string,
    input: StartImpersonationInput,
  ): Promise<{ session: ImpersonationSessionDto; accessToken: string }> {
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) {
      throw new NotFoundException(`Tenant "${tenantId}" was not found.`);
    }
    if (tenant.status === 'SUSPENDED' || tenant.status === 'CANCELLED') {
      throw new ForbiddenException('Cannot impersonate a user of a suspended or cancelled tenant.');
    }

    const targetUser = await prisma.user.findUnique({ where: { id: input.targetUserId } });
    if (!targetUser || targetUser.tenantId !== tenantId) {
      throw new NotFoundException(`User "${input.targetUserId}" was not found in this tenant.`);
    }
    if (targetUser.status !== 'ACTIVE') {
      throw new ForbiddenException('Cannot impersonate an inactive user.');
    }

    const minutes = Math.min(input.durationMinutes ?? DEFAULT_IMPERSONATION_MINUTES, MAX_IMPERSONATION_MINUTES);
    const expiresAt = new Date(Date.now() + minutes * 60_000);

    const session = await prisma.impersonationSession.create({
      data: { tenantId, targetUserId: targetUser.id, platformAdminId: actorId, reason: input.reason, expiresAt },
    });

    const accessToken = this.tokens.signImpersonationAccessToken(tenantId, targetUser.id, actorId, session.id, minutes * 60);

    const auditMetadata = {
      platformAdminId: actorId,
      targetUserId: targetUser.id,
      targetUserEmail: targetUser.email,
      reason: input.reason,
      expiresAt: expiresAt.toISOString(),
      sessionId: session.id,
    };
    await this.auditRecord.recordForTenant({
      tenantId,
      actor: { userId: null, platform: true },
      action: 'platform.impersonation.started',
      entityType: 'ImpersonationSession',
      entityId: session.id,
      metadata: auditMetadata,
    });
    await this.platformAudit.record({
      platformAdminId: actorId,
      action: 'platform.impersonation.started',
      entityType: 'ImpersonationSession',
      entityId: session.id,
      targetTenantId: tenantId,
      metadata: auditMetadata,
    });

    return { session: toDto(session), accessToken };
  }

  async end(actorId: string, actorRole: string, sessionId: string, reason: 'MANUAL' | 'REVOKED' = 'MANUAL'): Promise<ImpersonationSessionDto> {
    const session = await prisma.impersonationSession.findFirst({ where: { id: sessionId } });
    if (!session) {
      throw new NotFoundException(`Impersonation session "${sessionId}" was not found.`);
    }
    // Ending someone ELSE's active session is a revocation, held to a
    // higher bar (ADMIN_MANAGE, PLATFORM_OWNER-only, checked by the
    // controller's own decorator on the /revoke route) — this method only
    // allows self-service ending here, requiring the actor be the
    // session's own owner unless the caller explicitly went through the
    // revoke path (reason === 'REVOKED', gated separately).
    if (reason === 'MANUAL' && session.platformAdminId !== actorId) {
      throw new ForbiddenException('Only the platform admin who started this session may end it — use revoke instead.');
    }
    if (session.endedAt) {
      return toDto(session);
    }

    const ended = await prisma.impersonationSession.update({
      where: { id: session.id },
      data: { endedAt: new Date(), endedReason: reason },
    });

    const auditMetadata = { sessionId: session.id, endedBy: actorId, endedByRole: actorRole, reason };
    await this.auditRecord.recordForTenant({
      tenantId: session.tenantId,
      actor: { userId: null, platform: true },
      action: 'platform.impersonation.ended',
      entityType: 'ImpersonationSession',
      entityId: session.id,
      metadata: auditMetadata,
    });
    await this.platformAudit.record({
      platformAdminId: actorId,
      action: 'platform.impersonation.ended',
      entityType: 'ImpersonationSession',
      entityId: session.id,
      targetTenantId: session.tenantId,
      metadata: auditMetadata,
    });

    return toDto(ended);
  }

  async list(filters: { tenantId?: string; platformAdminId?: string; activeOnly?: boolean }): Promise<ImpersonationSessionDto[]> {
    const rows = await prisma.impersonationSession.findMany({
      where: {
        ...(filters.tenantId ? { tenantId: filters.tenantId } : {}),
        ...(filters.platformAdminId ? { platformAdminId: filters.platformAdminId } : {}),
        ...(filters.activeOnly ? { endedAt: null, expiresAt: { gt: new Date() } } : {}),
      },
      orderBy: { startedAt: 'desc' },
      take: 200,
    });
    return rows.map(toDto);
  }
}
