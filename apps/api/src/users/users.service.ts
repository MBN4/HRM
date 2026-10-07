import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@hrm/db';
import { SYSTEM_ROLES, type CreateUserInput, type ListUsersQuery, type UpdateUserAccessInput } from '@hrm/shared';
import { PasswordService } from '../auth/password.service';
import { PermissionsCacheService } from '../auth/permissions-cache.service';
import { TokenService } from '../auth/token.service';
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

    const temporaryPassword = generateTemporaryPassword();
    const user = await tx.user.create({
      data: {
        tenantId,
        email: input.email,
        hashedPassword: await this.password.hash(temporaryPassword),
        status: 'ACTIVE',
        mustChangePassword: true,
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
    return this.getSummary(tx, actor, userId);
  }

  async reactivate(tx: Prisma.TransactionClient, actor: UserActor, userId: string) {
    const target = await this.loadTarget(tx, userId);
    this.assertCanManage(actor, target);
    if (target.status === 'ACTIVE') {
      throw new ConflictException('This user is already active.');
    }
    await tx.user.update({ where: { id: userId }, data: { status: 'ACTIVE' } });
    return this.getSummary(tx, actor, userId);
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
      manageable,
    };
  }
}
