import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@hrm/db';
import { SYSTEM_ROLES, type CreateUserInput, type ListUsersQuery, type SetUserManagerInput, type UpdateUserAccessInput } from '@hrm/shared';
import { PasswordService } from '../auth/password.service';
import { PermissionsCacheService } from '../auth/permissions-cache.service';
import { TokenService } from '../auth/token.service';
import {
  canBeApprover,
  ChainReader,
  ChainRouting,
  ChainUserState,
  DbChainReader,
  resolveChainApprovers,
  wouldCreateCycle,
} from '../workflow/approval-chain';
import { WorkflowRoutingService } from '../workflow/workflow-routing.service';
import { generateTemporaryPassword } from './temp-password.util';

/** The acting user, as `TenantContextService` knows them — the guards below compare every target against THIS caller's own authority. */
export interface UserActor {
  userId: string;
  permissions: string[];
  /** null = unrestricted (no UserBranch rows). */
  branchIds: string[] | null;
}

const USER_INCLUDE = {
  roles: { include: { role: { include: { permissions: { include: { permission: true } } } } } },
  branches: { include: { branch: true } },
  employeeProfile: { select: { firstName: true, lastName: true } },
  manager: { select: { id: true, email: true, employeeProfile: { select: { firstName: true, lastName: true } } } },
  _count: { select: { directReports: true } },
} satisfies Prisma.UserInclude;

type UserRow = Prisma.UserGetPayload<{ include: typeof USER_INCLUDE }>;

export interface UserSummary {
  id: string;
  email: string;
  status: string;
  mustChangePassword: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
  roles: { id: string; name: string }[];
  /** Empty = unrestricted (every branch). */
  branches: { id: string; name: string }[];
  /** Linked Employee's name, when there is one — the friendlier label next to the email. */
  displayName: string | null;
  /** Step 7.2 — who this user reports to (null at the top of a chain). */
  managerId: string | null;
  manager: { id: string; email: string; displayName: string | null } | null;
  directReportCount: number;
  /** True when the CALLER may edit/deactivate this user — the UI hides actions otherwise (the server re-checks regardless). */
  manageable: boolean;
}

/**
 * Tenant user / team access management (step 7.1) — see
 * docs/conventions/user-management.md. Everything runs through the
 * request's own RLS-scoped `tx`, so a tenant can only ever see/touch its
 * own users even before the explicit guards below; those guards are the
 * second layer (no single layer trusted alone).
 *
 * Hashing, session revocation and the permission cache are the EXISTING
 * `PasswordService` (argon2id), `TokenService.revokeAllForUser` and
 * `PermissionsCacheService.invalidate` — nothing here reimplements auth.
 */
@Injectable()
export class UsersService {
  constructor(
    private readonly password: PasswordService,
    private readonly tokens: TokenService,
    private readonly permissionsCache: PermissionsCacheService,
    private readonly routing: WorkflowRoutingService,
  ) {}

  async list(tx: Prisma.TransactionClient, actor: UserActor, query: ListUsersQuery) {
    const where: Prisma.UserWhereInput = {};
    if (query.search) {
      where.email = { contains: query.search, mode: 'insensitive' };
    }
    if (query.status) {
      where.status = query.status;
    }
    // A branch-restricted caller only sees users whose scope overlaps theirs.
    if (actor.branchIds) {
      where.branches = { some: { branchId: { in: actor.branchIds } } };
    }

    const [total, rows] = await Promise.all([
      tx.user.count({ where }),
      tx.user.findMany({
        where,
        include: USER_INCLUDE,
        orderBy: [{ createdAt: 'desc' }, { email: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);

    return { items: rows.map((row) => this.toSummary(row, actor)), total, page: query.page, pageSize: query.pageSize };
  }

  /** Roles the CALLER may hand out: every permission the role carries is one the caller holds themselves. */
  async assignableRoles(tx: Prisma.TransactionClient, actor: UserActor) {
    const roles = await tx.role.findMany({
      include: { permissions: { include: { permission: true } } },
      orderBy: { name: 'asc' },
    });
    return roles.map((role) => ({
      id: role.id,
      name: role.name,
      isSystem: role.isSystem,
      assignable: this.isSubset(
        role.permissions.map((rp) => rp.permission.key),
        actor.permissions,
      ),
    }));
  }

  async create(tx: Prisma.TransactionClient, tenantId: string, actor: UserActor, input: CreateUserInput) {
    const existing = await tx.user.findFirst({ where: { email: { equals: input.email, mode: 'insensitive' } } });
    if (existing) {
      throw new ConflictException('A user with this email already exists.');
    }

    const roles = await this.loadAssignableRoles(tx, actor, input.roleIds);
    this.assertBranchGrantAllowed(actor, input.branchIds);
    await this.assertBranchesExist(tx, input.branchIds);
    if (input.managerId) {
      await this.loadActiveManager(tx, input.managerId);
    }

    const temporaryPassword = generateTemporaryPassword();
    const user = await tx.user.create({
      data: {
        tenantId,
        email: input.email,
        hashedPassword: await this.password.hash(temporaryPassword),
        status: 'ACTIVE',
        mustChangePassword: true,
        managerId: input.managerId ?? null,
      },
    });
    await tx.userRole.createMany({ data: roles.map((role) => ({ tenantId, userId: user.id, roleId: role.id })) });
    if (input.branchIds.length > 0) {
      await tx.userBranch.createMany({ data: input.branchIds.map((branchId) => ({ tenantId, userId: user.id, branchId })) });
    }
    await this.permissionsCache.invalidate(tenantId, user.id);

    // The plaintext exists only in this response — never stored, and the
    // audit layer redacts any `*password*` field (see packages/shared audit/redact.ts).
    return { ...(await this.getSummary(tx, actor, user.id)), temporaryPassword };
  }

  async updateAccess(tx: Prisma.TransactionClient, tenantId: string, actor: UserActor, userId: string, input: UpdateUserAccessInput) {
    const target = await this.loadTarget(tx, userId);
    this.assertNotSelf(actor, target, 'You cannot change your own roles or branch scope.');
    this.assertCanManage(actor, target);

    if (input.roleIds) {
      const roles = await this.loadAssignableRoles(tx, actor, input.roleIds);
      const keepsAdmin = roles.some((role) => role.isSystem && role.name === SYSTEM_ROLES.TENANT_ADMIN);
      if (this.isAdmin(target) && !keepsAdmin) {
        await this.assertAnotherActiveAdmin(tx, target.id);
      }
      await tx.userRole.deleteMany({ where: { userId } });
      await tx.userRole.createMany({ data: roles.map((role) => ({ tenantId, userId, roleId: role.id })) });
    }
    if (input.branchIds) {
      this.assertBranchGrantAllowed(actor, input.branchIds);
      await this.assertBranchesExist(tx, input.branchIds);
      await tx.userBranch.deleteMany({ where: { userId } });
      if (input.branchIds.length > 0) {
        await tx.userBranch.createMany({ data: input.branchIds.map((branchId) => ({ tenantId, userId, branchId })) });
      }
    }

    // Role/branch edits take effect on the target's very next request —
    // the cache's 15s TTL is NOT left to bound staleness here (this is the
    // real write path its own doc comment said must invalidate).
    await this.permissionsCache.invalidate(tenantId, userId);
    // A role change can make this user (in)eligible as an approver (HR / CEO).
    if (input.roleIds) {
      await this.routing.rerouteActiveChainSteps(tx, tenantId);
    }
    return this.getSummary(tx, actor, userId);
  }

  async deactivate(tx: Prisma.TransactionClient, tenantId: string, actor: UserActor, userId: string) {
    const target = await this.loadTarget(tx, userId);
    this.assertNotSelf(actor, target, 'You cannot deactivate your own account.');
    this.assertCanManage(actor, target);
    if (target.status === 'DISABLED') {
      throw new ConflictException('This user is already deactivated.');
    }
    if (this.isAdmin(target)) {
      await this.assertAnotherActiveAdmin(tx, target.id);
    }

    // No hard delete: audit/approval/workflow history keeps pointing at
    // this row. DISABLED is blocked at login AND by TenantScopeInterceptor
    // on every request (the status is re-read from the DB each time), so
    // existing access tokens die immediately; revoking the refresh
    // families stops them minting new ones.
    await tx.user.update({ where: { id: userId }, data: { status: 'DISABLED' } });
    await this.tokens.revokeAllForUser(tenantId, userId);
    await this.permissionsCache.invalidate(tenantId, userId);
    // Step 7.2: anything currently waiting on this person escalates up the chain NOW.
    await this.routing.rerouteActiveChainSteps(tx, tenantId);
    return this.getSummary(tx, actor, userId);
  }

  async reactivate(tx: Prisma.TransactionClient, tenantId: string, actor: UserActor, userId: string) {
    const target = await this.loadTarget(tx, userId);
    this.assertCanManage(actor, target);
    if (target.status === 'ACTIVE') {
      throw new ConflictException('This user is already active.');
    }
    await tx.user.update({ where: { id: userId }, data: { status: 'ACTIVE' } });
    // ...and a returning manager takes their direct reports' pending requests back.
    await this.routing.rerouteActiveChainSteps(tx, tenantId);
    return this.getSummary(tx, actor, userId);
  }

  /**
   * Step 7.2 — set/change/clear who `userId` reports to. Guards: not yourself,
   * you must be able to manage the target (the 7.1 escalation guard), the
   * manager must exist and be ACTIVE, and the new link must not close a loop
   * (A -> B -> ... -> A). Pending approvals reroute immediately.
   */
  async setManager(tx: Prisma.TransactionClient, tenantId: string, actor: UserActor, userId: string, input: SetUserManagerInput) {
    const target = await this.loadTarget(tx, userId);
    this.assertNotSelf(actor, target, 'You cannot change who you report to — ask a colleague with access.');
    this.assertCanManage(actor, target);

    if (input.managerId) {
      if (input.managerId === userId) {
        throw new BadRequestException('A person cannot report to themselves.');
      }
      await this.loadActiveManager(tx, input.managerId);
      if (await wouldCreateCycle(new DbChainReader(tx), userId, input.managerId)) {
        throw new BadRequestException('That would create a reporting loop: the chosen manager already reports (directly or indirectly) to this person.');
      }
    }

    await tx.user.update({ where: { id: userId }, data: { managerId: input.managerId } });
    await this.routing.rerouteActiveChainSteps(tx, tenantId);
    return this.getSummary(tx, actor, userId);
  }

  /**
   * The whole reporting hierarchy for the org-chart screen: every user (branch-
   * scoped callers see their scope) with role names, manager link, and — via the
   * SAME chain walker the workflow engine uses — who currently approves THEIR
   * requests and why (so a deactivated manager visibly escalates).
   */
  async hierarchy(tx: Prisma.TransactionClient, actor: UserActor) {
    const rows = await tx.user.findMany({
      take: 5000,
      orderBy: { email: 'asc' },
      select: {
        id: true,
        email: true,
        status: true,
        managerId: true,
        employeeProfile: { select: { firstName: true, lastName: true, managerId: true } },
        roles: { select: { role: { select: { name: true } } } },
        branches: { select: { branchId: true } },
      },
    });
    const employeeUserIds = new Map<string, string | null>();
    const employees = await tx.employee.findMany({ where: { userId: { not: null } }, select: { id: true, userId: true, managerId: true } });
    for (const e of employees) employeeUserIds.set(e.id, e.userId);

    const states = new Map<string, ChainUserState>();
    const managers = new Map<string, string | null>();
    for (const r of rows) {
      states.set(r.id, { id: r.id, email: r.email, status: r.status, roleNames: r.roles.map((x) => x.role.name) });
      const viaEmployee = r.employeeProfile?.managerId ? (employeeUserIds.get(r.employeeProfile.managerId) ?? null) : null;
      managers.set(r.id, r.managerId ?? viaEmployee);
    }
    const reader: ChainReader = {
      managerOf: async (id) => managers.get(id) ?? null,
      stateOf: async (id) => states.get(id) ?? null,
      activeUsersWithRole: async (roleName) => [...states.values()].filter((s) => s.status === 'ACTIVE' && s.roleNames.includes(roleName)),
    };
    const nameOf = (id: string) => {
      const row = rows.find((x) => x.id === id);
      return row?.employeeProfile ? `${row.employeeProfile.firstName} ${row.employeeProfile.lastName}` : null;
    };
    const reportCounts = new Map<string, number>();
    for (const [id, managerId] of managers) {
      void id;
      if (managerId) reportCounts.set(managerId, (reportCounts.get(managerId) ?? 0) + 1);
    }

    const visible = actor.branchIds ? rows.filter((r) => r.branches.some((b) => actor.branchIds!.includes(b.branchId))) : rows;
    const items = [];
    for (const r of visible) {
      const resolved = await resolveChainApprovers(reader, r.id);
      items.push({
        id: r.id,
        email: r.email,
        displayName: nameOf(r.id),
        status: r.status,
        roles: r.roles.map((x) => x.role.name),
        managerId: managers.get(r.id) ?? null,
        directReportCount: reportCounts.get(r.id) ?? 0,
        approvers: resolved.approverIds.map((id) => ({ id, email: states.get(id)?.email ?? '', displayName: nameOf(id) })),
        routing: resolved.routing as ChainRouting,
        isApprover: canBeApprover(states.get(r.id)!),
      });
    }
    return { items };
  }

  /**
   * For a member who lost their temporary password before first login (or
   * needs an HR-assisted reset): a NEW temporary password,
   * `mustChangePassword=true` again, every existing session revoked. The
   * old password stops working immediately (it's overwritten).
   */
  async regenerateTemporaryPassword(tx: Prisma.TransactionClient, tenantId: string, actor: UserActor, userId: string) {
    const target = await this.loadTarget(tx, userId);
    this.assertNotSelf(actor, target, 'Use "Forgot password" to reset your own password.');
    this.assertCanManage(actor, target);
    if (target.status === 'DISABLED') {
      throw new ConflictException('Reactivate this user before generating a temporary password.');
    }

    const temporaryPassword = generateTemporaryPassword();
    await tx.user.update({
      where: { id: userId },
      data: { hashedPassword: await this.password.hash(temporaryPassword), mustChangePassword: true },
    });
    await this.tokens.revokeAllForUser(tenantId, userId);
    return { ...(await this.getSummary(tx, actor, userId)), temporaryPassword };
  }

  // --- helpers --------------------------------------------------------

  private async getSummary(tx: Prisma.TransactionClient, actor: UserActor, userId: string): Promise<UserSummary> {
    return this.toSummary(await this.loadTarget(tx, userId), actor);
  }

  private async loadTarget(tx: Prisma.TransactionClient, userId: string): Promise<UserRow> {
    // RLS makes another tenant's user simply not exist here -> 404, never 403.
    const user = await tx.user.findUnique({ where: { id: userId }, include: USER_INCLUDE });
    if (!user) {
      throw new NotFoundException('User not found.');
    }
    return user;
  }

  private async loadActiveManager(tx: Prisma.TransactionClient, managerId: string) {
    const manager = await tx.user.findUnique({ where: { id: managerId }, select: { id: true, status: true } });
    if (!manager) {
      throw new BadRequestException('The chosen manager does not exist.');
    }
    if (manager.status !== 'ACTIVE') {
      throw new BadRequestException('The chosen manager is deactivated — pick an active user.');
    }
    return manager;
  }

  private async loadAssignableRoles(tx: Prisma.TransactionClient, actor: UserActor, roleIds: string[]) {
    const unique = [...new Set(roleIds)];
    const roles = await tx.role.findMany({
      where: { id: { in: unique } },
      include: { permissions: { include: { permission: true } } },
    });
    if (roles.length !== unique.length) {
      throw new BadRequestException('One or more roles do not exist.');
    }
    for (const role of roles) {
      if (
        !this.isSubset(
          role.permissions.map((rp) => rp.permission.key),
          actor.permissions,
        )
      ) {
        throw new ForbiddenException(`You cannot grant the "${role.name}" role: it carries permissions you do not hold.`);
      }
    }
    return roles;
  }

  private async assertBranchesExist(tx: Prisma.TransactionClient, branchIds: string[]) {
    const unique = [...new Set(branchIds)];
    if (unique.length === 0) return;
    const count = await tx.branch.count({ where: { id: { in: unique } } });
    if (count !== unique.length) {
      throw new BadRequestException('One or more branches do not exist.');
    }
  }

  /** A branch-restricted caller may only hand out scopes within their own — and may not grant "unrestricted" (an empty list). */
  private assertBranchGrantAllowed(actor: UserActor, branchIds: string[]) {
    if (!actor.branchIds) return;
    if (branchIds.length === 0 || branchIds.some((id) => !actor.branchIds!.includes(id))) {
      throw new ForbiddenException('You can only assign branches within your own branch scope.');
    }
  }

  private assertNotSelf(actor: UserActor, target: UserRow, message: string) {
    if (target.id === actor.userId) {
      throw new ForbiddenException(message);
    }
  }

  /**
   * THE privilege-escalation guard: a caller may only manage a user whose
   * current authority they fully cover. Without it an HR manager holding
   * `user.manage` could regenerate the TENANT_ADMIN's temporary password
   * and log in as them. A branch-restricted caller additionally can't touch
   * users outside their branch scope.
   */
  private assertCanManage(actor: UserActor, target: UserRow) {
    const targetPermissions = target.roles.flatMap((ur) => ur.role.permissions.map((rp) => rp.permission.key));
    if (!this.isSubset(targetPermissions, actor.permissions)) {
      throw new ForbiddenException('You cannot manage a user who holds permissions you do not have.');
    }
    if (actor.branchIds) {
      const targetBranchIds = target.branches.map((ub) => ub.branchId);
      if (targetBranchIds.length === 0 || targetBranchIds.some((id) => !actor.branchIds!.includes(id))) {
        throw new ForbiddenException('This user is outside your branch scope.');
      }
    }
  }

  private isAdmin(user: UserRow): boolean {
    return user.status === 'ACTIVE' && user.roles.some((ur) => ur.role.isSystem && ur.role.name === SYSTEM_ROLES.TENANT_ADMIN);
  }

  private async assertAnotherActiveAdmin(tx: Prisma.TransactionClient, excludingUserId: string) {
    const others = await tx.user.count({
      where: {
        id: { not: excludingUserId },
        status: 'ACTIVE',
        roles: { some: { role: { isSystem: true, name: SYSTEM_ROLES.TENANT_ADMIN } } },
      },
    });
    if (others === 0) {
      throw new ConflictException('This is the last active admin — the tenant must always keep at least one.');
    }
  }

  private isSubset(needed: string[], held: string[]): boolean {
    const heldSet = new Set(held);
    return needed.every((key) => heldSet.has(key));
  }

  private toSummary(row: UserRow, actor: UserActor): UserSummary {
    let manageable = row.id !== actor.userId;
    if (manageable) {
      try {
        this.assertCanManage(actor, row);
      } catch {
        manageable = false;
      }
    }
    return {
      id: row.id,
      email: row.email,
      status: row.status,
      mustChangePassword: row.mustChangePassword,
      lastLoginAt: row.lastLoginAt,
      createdAt: row.createdAt,
      roles: row.roles.map((ur) => ({ id: ur.role.id, name: ur.role.name })),
      branches: row.branches.map((ub) => ({ id: ub.branch.id, name: ub.branch.name })),
      displayName: row.employeeProfile ? `${row.employeeProfile.firstName} ${row.employeeProfile.lastName}` : null,
      managerId: row.managerId,
      manager: row.manager
        ? {
            id: row.manager.id,
            email: row.manager.email,
            displayName: row.manager.employeeProfile ? `${row.manager.employeeProfile.firstName} ${row.manager.employeeProfile.lastName}` : null,
          }
        : null,
      directReportCount: row._count.directReports,
      manageable,
    };
  }
}
