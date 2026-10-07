import type { HierarchyUser } from './api/users';

/** Step 7.2 — pure helpers over the `GET /users/hierarchy` list (see docs/conventions/user-management.md). */

export type RoleLabelKey = 'CEO' | 'ADMIN' | 'HR' | 'MANAGER' | 'MEMBER';

/** Collapses a user's role NAMES into ONE display label (highest wins); the raw names stay available as a tooltip. */
export function primaryRoleLabel(roles: string[], directReportCount: number): RoleLabelKey {
  if (roles.includes('CEO')) return 'CEO';
  if (roles.includes('TENANT_ADMIN')) return 'ADMIN';
  if (roles.includes('HR_MANAGER')) return 'HR';
  if (roles.includes('MANAGER') || directReportCount > 0) return 'MANAGER';
  return 'MEMBER';
}

export function userName(u: { displayName: string | null; email: string }): string {
  return u.displayName?.trim() || u.email;
}

export interface TreeNode {
  user: HierarchyUser;
  children: TreeNode[];
}

function byName(a: HierarchyUser, b: HierarchyUser): number {
  return userName(a).localeCompare(userName(b));
}

/**
 * Builds the forest from `managerId`. Roots = no manager, or a manager that
 * isn't in the list. Cycle-safe: every user is placed at most once, and any
 * user left unplaced after the root pass (members of a loop) becomes a root.
 */
export function buildTree(items: HierarchyUser[]): TreeNode[] {
  const byId = new Map(items.map((u) => [u.id, u]));
  const childrenOf = new Map<string, HierarchyUser[]>();
  const rootUsers: HierarchyUser[] = [];
  for (const u of items) {
    if (u.managerId && byId.has(u.managerId) && u.managerId !== u.id) {
      const list = childrenOf.get(u.managerId) ?? [];
      list.push(u);
      childrenOf.set(u.managerId, list);
    } else {
      rootUsers.push(u);
    }
  }
  const placed = new Set<string>();
  function build(u: HierarchyUser): TreeNode {
    placed.add(u.id);
    const kids = (childrenOf.get(u.id) ?? []).filter((c) => !placed.has(c.id)).sort(byName);
    return { user: u, children: kids.map((c) => (placed.has(c.id) ? null : build(c))).filter((n): n is TreeNode => n !== null) };
  }
  const roots = rootUsers.sort(byName).map(build);
  for (const u of [...items].sort(byName)) {
    if (!placed.has(u.id)) roots.push(build(u));
  }
  return roots;
}

/** Ids of everyone below `userId` (reports, their reports, ...). Cycle-safe. */
export function descendantIds(items: HierarchyUser[], userId: string): Set<string> {
  const childrenOf = new Map<string, string[]>();
  for (const u of items) {
    if (u.managerId) childrenOf.set(u.managerId, [...(childrenOf.get(u.managerId) ?? []), u.id]);
  }
  const out = new Set<string>();
  const stack = [userId];
  while (stack.length) {
    for (const child of childrenOf.get(stack.pop()!) ?? []) {
      if (!out.has(child) && child !== userId) {
        out.add(child);
        stack.push(child);
      }
    }
  }
  return out;
}

/** Flat list of every node id with children (for expand/collapse-all). */
export function branchIds(roots: TreeNode[]): string[] {
  const out: string[] = [];
  const walk = (n: TreeNode) => {
    if (n.children.length) out.push(n.user.id);
    n.children.forEach(walk);
  };
  roots.forEach(walk);
  return out;
}

/** Ids of every ancestor of a search match — these are force-expanded so a hit is never hidden. */
export function ancestorsOfMatches(roots: TreeNode[], isMatch: (u: HierarchyUser) => boolean): { matches: Set<string>; ancestors: Set<string> } {
  const matches = new Set<string>();
  const ancestors = new Set<string>();
  const walk = (n: TreeNode, path: string[]) => {
    if (isMatch(n.user)) {
      matches.add(n.user.id);
      path.forEach((id) => ancestors.add(id));
    }
    n.children.forEach((c) => walk(c, [...path, n.user.id]));
  };
  roots.forEach((r) => walk(r, []));
  return { matches, ancestors };
}
