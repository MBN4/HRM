import type { Prisma } from '@hrm/db';
import { SYSTEM_ROLES } from '@hrm/shared';

/**
 * The hierarchical approval chain (step 7.2) — see
 * docs/conventions/team-hierarchy-approvals.md.
 *
 * ONE walker, two readers: `resolveChainApprovers` is pure logic over a tiny
 * `ChainReader`, so the live approver resolution (`DbChainReader`, tx-backed)
 * and the org-chart "who approves this person" preview (a snapshot reader in
 * `UsersService`) can never drift apart.
 */

/** Why the resolved approver is who it is — stored on `WorkflowInstanceStep.routing` and shown in the approvals inbox. */
export type RoutingKind =
  | 'DIRECT_MANAGER'
  | 'ESCALATED_MANAGER_UNAVAILABLE'
  | 'CEO_TOP_OF_CHAIN'
  | 'CEO_ESCALATED'
  | 'ADMIN_FALLBACK'
  | 'NO_APPROVER';

export type SkipReason = 'DEACTIVATED' | 'HR_EXCLUDED' | 'NOT_FOUND';

export interface SkippedApprover {
  userId: string;
  email: string | null;
  why: SkipReason;
}

export interface ChainRouting {
  kind: RoutingKind;
  skipped: SkippedApprover[];
}

export interface ChainUserState {
  id: string;
  email: string;
  status: string;
  roleNames: string[];
}

export interface ChainReader {
  /** The user's manager (a user id), or null at the top of a chain. */
  managerOf(userId: string): Promise<string | null>;
  stateOf(userId: string): Promise<ChainUserState | null>;
  /** Every ACTIVE user holding the named role. */
  activeUsersWithRole(roleName: string): Promise<ChainUserState[]>;
}

/** HR administers, it does not authorize — unless the same person is also the CEO, whose authority is total. */
export function isHrExcluded(roleNames: readonly string[]): boolean {
  return roleNames.includes(SYSTEM_ROLES.HR_MANAGER) && !roleNames.includes(SYSTEM_ROLES.CEO);
}

export function isCeo(roleNames: readonly string[]): boolean {
  return roleNames.includes(SYSTEM_ROLES.CEO);
}

/** A user who may legitimately be an approver at all: active and not HR-excluded. */
export function canBeApprover(state: ChainUserState): boolean {
  return state.status === 'ACTIVE' && !isHrExcluded(state.roleNames);
}

const MAX_CHAIN_DEPTH = 64;

/**
 * Walks UP the management chain from `requesterId`:
 *  - the first ACTIVE, non-HR manager is the approver (DIRECT if it is the
 *    requester's own manager, ESCALATED when one or more were skipped);
 *  - a manager who is deactivated / missing / HR is skipped and the walk
 *    continues to THEIR manager;
 *  - running off the top (or hitting a defensive cycle) falls back to the
 *    ACTIVE CEO(s), then — only if no CEO is available — to active tenant
 *    admins as a last resort, then to nobody (`NO_APPROVER`).
 * The requester is never their own approver, at any level.
 */
export async function resolveChainApprovers(
  reader: ChainReader,
  requesterId: string,
): Promise<{ approverIds: string[]; routing: ChainRouting }> {
  const skipped: SkippedApprover[] = [];
  const visited = new Set<string>([requesterId]);
  let current = requesterId;

  for (let depth = 0; depth < MAX_CHAIN_DEPTH; depth += 1) {
    const managerId = await reader.managerOf(current);
    if (!managerId || visited.has(managerId)) {
      break;
    }
    visited.add(managerId);
    const manager = await reader.stateOf(managerId);
    if (!manager) {
      skipped.push({ userId: managerId, email: null, why: 'NOT_FOUND' });
    } else if (manager.status !== 'ACTIVE') {
      skipped.push({ userId: manager.id, email: manager.email, why: 'DEACTIVATED' });
    } else if (isHrExcluded(manager.roleNames)) {
      skipped.push({ userId: manager.id, email: manager.email, why: 'HR_EXCLUDED' });
    } else {
      return {
        approverIds: [manager.id],
        routing: { kind: skipped.length === 0 ? 'DIRECT_MANAGER' : 'ESCALATED_MANAGER_UNAVAILABLE', skipped },
      };
    }
    current = managerId;
  }

  const ceos = (await reader.activeUsersWithRole(SYSTEM_ROLES.CEO)).filter((u) => u.id !== requesterId && canBeApprover(u));
  if (ceos.length > 0) {
    return {
      approverIds: ceos.map((u) => u.id),
      routing: { kind: skipped.length === 0 ? 'CEO_TOP_OF_CHAIN' : 'CEO_ESCALATED', skipped },
    };
  }

  const admins = (await reader.activeUsersWithRole(SYSTEM_ROLES.TENANT_ADMIN)).filter((u) => u.id !== requesterId && canBeApprover(u));
  if (admins.length > 0) {
    return { approverIds: admins.map((u) => u.id), routing: { kind: 'ADMIN_FALLBACK', skipped } };
  }
  return { approverIds: [], routing: { kind: 'NO_APPROVER', skipped } };
}

/**
 * Would pointing `userId` at `newManagerId` close a loop? True when walking up
 * from the proposed manager reaches `userId` (including `newManagerId === userId`).
 */
export async function wouldCreateCycle(reader: Pick<ChainReader, 'managerOf'>, userId: string, newManagerId: string): Promise<boolean> {
  const seen = new Set<string>();
  let current: string | null = newManagerId;
  while (current && !seen.has(current)) {
    if (current === userId) {
      return true;
    }
    seen.add(current);
    current = await reader.managerOf(current);
  }
  return false;
}

/**
 * The tx-backed reader. The manager link is `User.managerId` (the explicit
 * hierarchy the team-access screens edit); a user with NO `User.managerId`
 * falls back to the 1.1 `Employee.managerId` org chart (resolved to the
 * manager employee's linked user) so every pre-7.2 tenant keeps working.
 * Results are memoized per reader instance (one resolution call).
 */
export class DbChainReader implements ChainReader {
  private readonly states = new Map<string, ChainUserState | null>();

  constructor(private readonly tx: Prisma.TransactionClient) {}

  async managerOf(userId: string): Promise<string | null> {
    const user = await this.tx.user.findUnique({ where: { id: userId }, select: { managerId: true } });
    if (user?.managerId) {
      return user.managerId;
    }
    const employee = await this.tx.employee.findFirst({ where: { userId }, select: { managerId: true } });
    if (!employee?.managerId) {
      return null;
    }
    const manager = await this.tx.employee.findUnique({ where: { id: employee.managerId }, select: { userId: true } });
    return manager?.userId ?? null;
  }

  async stateOf(userId: string): Promise<ChainUserState | null> {
    if (this.states.has(userId)) {
      return this.states.get(userId) ?? null;
    }
    const user = await this.tx.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, status: true, roles: { select: { role: { select: { name: true } } } } },
    });
    const state = user ? { id: user.id, email: user.email, status: user.status, roleNames: user.roles.map((r) => r.role.name) } : null;
    this.states.set(userId, state);
    return state;
  }

  async activeUsersWithRole(roleName: string): Promise<ChainUserState[]> {
    const users = await this.tx.user.findMany({
      where: { status: 'ACTIVE', roles: { some: { role: { name: roleName } } } },
      select: { id: true, email: true, status: true, roles: { select: { role: { select: { name: true } } } } },
      orderBy: { createdAt: 'asc' },
    });
    return users.map((user) => ({ id: user.id, email: user.email, status: user.status, roleNames: user.roles.map((r) => r.role.name) }));
  }
}
