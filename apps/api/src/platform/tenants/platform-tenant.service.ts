import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { prisma, seedSystemRolesAndPermissions } from '@hrm/db';
import {
  SYSTEM_ROLES,
  type DeleteTenantInput,
  type PlatformCreateTenantInput,
  type PlatformUpdateTenantInput,
  type SuspendTenantInput,
} from '@hrm/shared';
import { AuditRecordService } from '../../audit/audit-record.service';
import { PasswordService } from '../../auth/password.service';
import { PlatformAuditRecordService } from '../audit/platform-audit-record.service';

export interface TenantSummary {
  id: string;
  name: string;
  slug: string;
  status: string;
  edition: string;
  provisionMode: string;
  hostingRegion: string;
  defaultCountryCode: string;
  baseCurrencyCode: string;
  createdAt: string;
  subscription: { edition: string; status: string; seatCap: number | null } | null;
  activeLicense: { edition: string; seatCap: number; expiresAt: string | null } | null;
}

async function toSummary(tenant: {
  id: string;
  name: string;
  slug: string;
  status: string;
  edition: string;
  provisionMode: string;
  hostingRegion: string;
  defaultCountryCode: string;
  baseCurrencyCode: string;
  createdAt: Date;
}): Promise<TenantSummary> {
  const [subscription, activeLicense] = await Promise.all([
    prisma.subscription.findUnique({ where: { tenantId: tenant.id } }),
    prisma.license.findFirst({ where: { tenantId: tenant.id, status: 'ACTIVE' }, orderBy: { issuedAt: 'desc' } }),
  ]);

  return {
    id: tenant.id,
    name: tenant.name,
    slug: tenant.slug,
    status: tenant.status,
    edition: tenant.edition,
    provisionMode: tenant.provisionMode,
    hostingRegion: tenant.hostingRegion,
    defaultCountryCode: tenant.defaultCountryCode,
    baseCurrencyCode: tenant.baseCurrencyCode,
    createdAt: tenant.createdAt.toISOString(),
    subscription: subscription
      ? { edition: subscription.edition, status: subscription.status, seatCap: subscription.seatCap }
      : null,
    activeLicense: activeLicense
      ? { edition: activeLicense.edition, seatCap: activeLicense.seatCap, expiresAt: activeLicense.expiresAt?.toISOString() ?? null }
      : null,
  };
}

/**
 * Tenant lifecycle — the vendor console's core lever (step 4.1). Every
 * mutation here runs through the owner `prisma` client (a platform
 * request opens no tenant-scoped transaction — see
 * docs/conventions/tenant-resolution.md → Platform context) AND is
 * recorded into the TARGET TENANT'S OWN `audit_log` via the EXISTING
 * `AuditRecordService.recordForTenant` (`actorPlatform: true`, the same
 * convention 0.6's `LicensingAdminService` already established) — a
 * tenant-targeted action has a natural home to audit into, unlike
 * country-pack authoring or a cross-tenant listing, which only reach
 * `PlatformAuditRecordService` (see that service's own doc comment).
 */
@Injectable()
export class PlatformTenantService {
  constructor(
    private readonly password: PasswordService,
    private readonly auditRecord: AuditRecordService,
    private readonly platformAudit: PlatformAuditRecordService,
  ) {}

  async list(): Promise<TenantSummary[]> {
    const tenants = await prisma.tenant.findMany({ orderBy: { createdAt: 'desc' } });
    return Promise.all(tenants.map(toSummary));
  }

  async detail(id: string): Promise<TenantSummary> {
    const tenant = await this.requireTenant(id);
    return toSummary(tenant);
  }

  /**
   * A lightweight user picker for the vendor console's impersonation flow
   * — no email/personal data beyond what's already on `User` itself (no
   * `Employee` join). Owner-client read, explicitly scoped by `tenantId`,
   * the same class of legitimate cross-tenant read this whole service
   * already takes for granted.
   */
  async listUsers(tenantId: string): Promise<{ id: string; email: string; status: string }[]> {
    await this.requireTenant(tenantId);
    const users = await prisma.user.findMany({
      where: { tenantId },
      select: { id: true, email: true, status: true },
      orderBy: { email: 'asc' },
    });
    return users;
  }

  async create(actorId: string, input: PlatformCreateTenantInput): Promise<TenantSummary> {
    const existing = await prisma.tenant.findUnique({ where: { slug: input.slug } });
    if (existing) {
      throw new ConflictException(`A tenant with slug "${input.slug}" already exists.`);
    }

    const tenant = await prisma.tenant.create({
      data: {
        name: input.name,
        slug: input.slug,
        defaultCountryCode: input.defaultCountryCode,
        hostingRegion: input.hostingRegion,
        edition: input.edition ?? 'STARTER',
        provisionMode: input.provisionMode ?? 'SHARED_DB',
        baseCurrencyCode: input.baseCurrencyCode ?? 'USD',
      },
    });

    // Real tenant provisioning MUST seed RBAC — see seedSystemRolesAndPermissions's
    // own doc comment ("this is also the function real tenant provisioning
    // should call for every new tenant, don't duplicate this logic
    // elsewhere"). Without this, a freshly created tenant has no roles/
    // permissions at all and nobody could ever be granted access.
    await seedSystemRolesAndPermissions(prisma, tenant.id);

    let initialAdminUserId: string | null = null;
    if (input.initialAdminEmail && input.initialAdminName && input.initialAdminPassword) {
      const hashedPassword = await this.password.hash(input.initialAdminPassword);
      const user = await prisma.user.create({
        data: { tenantId: tenant.id, email: input.initialAdminEmail, hashedPassword, status: 'ACTIVE' },
      });
      const adminRole = await prisma.role.findUniqueOrThrow({
        where: { tenantId_name: { tenantId: tenant.id, name: SYSTEM_ROLES.TENANT_ADMIN } },
      });
      await prisma.userRole.create({ data: { tenantId: tenant.id, userId: user.id, roleId: adminRole.id } });
      initialAdminUserId = user.id;
    }

    await this.recordTenantAudit(actorId, tenant.id, 'platform.tenant.created', null, {
      name: tenant.name,
      slug: tenant.slug,
      edition: tenant.edition,
      hostingRegion: tenant.hostingRegion,
      provisionMode: tenant.provisionMode,
      initialAdminUserId,
    });

    return toSummary(tenant);
  }

  async update(actorId: string, id: string, input: PlatformUpdateTenantInput): Promise<TenantSummary> {
    const before = await this.requireTenant(id);
    const tenant = await prisma.tenant.update({
      where: { id },
      data: {
        edition: input.edition,
        hostingRegion: input.hostingRegion,
        provisionMode: input.provisionMode,
      },
    });

    await this.recordTenantAudit(
      actorId,
      id,
      'platform.tenant.updated',
      { edition: before.edition, hostingRegion: before.hostingRegion, provisionMode: before.provisionMode },
      { edition: tenant.edition, hostingRegion: tenant.hostingRegion, provisionMode: tenant.provisionMode },
    );

    return toSummary(tenant);
  }

  async suspend(actorId: string, id: string, input: SuspendTenantInput): Promise<TenantSummary> {
    const before = await this.requireTenant(id);
    const tenant = await prisma.tenant.update({ where: { id }, data: { status: 'SUSPENDED' } });

    await this.recordTenantAudit(actorId, id, 'platform.tenant.suspended', { status: before.status }, {
      status: tenant.status,
      reason: input.reason ?? null,
    });

    return toSummary(tenant);
  }

  async resume(actorId: string, id: string): Promise<TenantSummary> {
    const before = await this.requireTenant(id);
    const tenant = await prisma.tenant.update({ where: { id }, data: { status: 'ACTIVE' } });

    await this.recordTenantAudit(actorId, id, 'platform.tenant.resumed', { status: before.status }, {
      status: tenant.status,
    });

    return toSummary(tenant);
  }

  /**
   * A genuine, irreversible hard delete — every relation in schema.prisma
   * cascades from `Tenant`, so this removes every row the tenant ever
   * owned. Gated by requiring `confirmSlug` to match the tenant's OWN
   * slug exactly (the type-to-confirm pattern), on top of the route's own
   * `TENANT_DELETE` permission (deliberately separate from `TENANT_MANAGE`
   * — see PLATFORM_PERMISSIONS's own doc comment) — the most tightly held
   * permission in the platform catalog, for the most destructive action
   * it can perform.
   */
  async remove(actorId: string, id: string, input: DeleteTenantInput): Promise<void> {
    const tenant = await this.requireTenant(id);
    if (input.confirmSlug !== tenant.slug) {
      throw new BadRequestException('confirmSlug must exactly match the tenant slug to confirm deletion.');
    }

    // The tenant's OWN audit_log is about to be cascaded away with
    // everything else it owns — record this irreversible action into the
    // PLATFORM's own trail (which survives the tenant's deletion) BEFORE
    // deleting, not into the tenant's own log which wouldn't survive it.
    await this.platformAudit.record({
      platformAdminId: actorId,
      action: 'platform.tenant.deleted',
      entityType: 'Tenant',
      entityId: tenant.id,
      targetTenantId: tenant.id,
      before: { name: tenant.name, slug: tenant.slug, status: tenant.status, edition: tenant.edition },
    });

    await prisma.tenant.delete({ where: { id } });
  }

  private async requireTenant(id: string) {
    const tenant = await prisma.tenant.findUnique({ where: { id } });
    if (!tenant) {
      throw new NotFoundException(`Tenant "${id}" was not found.`);
    }
    return tenant;
  }

  private async recordTenantAudit(
    actorId: string,
    tenantId: string,
    action: string,
    before: unknown,
    after: unknown,
  ): Promise<void> {
    await this.auditRecord.recordForTenant({
      tenantId,
      actor: { userId: null, platform: true },
      action,
      entityType: 'Tenant',
      entityId: tenantId,
      before,
      after,
      metadata: { platformAdminId: actorId },
    });
    await this.platformAudit.record({
      platformAdminId: actorId,
      action,
      entityType: 'Tenant',
      entityId: tenantId,
      targetTenantId: tenantId,
      before,
      after,
    });
  }
}
