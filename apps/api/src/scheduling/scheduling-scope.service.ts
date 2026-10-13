import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { Employee, Prisma } from '@hrm/db';
import { DbChainReader } from '../workflow/approval-chain';

export interface SchedulingActor {
  userId: string;
  /** null = unrestricted (no UserBranch rows). */
  branchIds: string[] | null;
  /**
   * Tenant-wide scheduling authority = `working_hours.manage` (HR / admin / CEO): may define shifts,
   * set team/company standing shifts and roster anyone in their branch scope. Without it (a MANAGER)
   * the actor may only act on people BELOW them in the management chain (the 7.2 hierarchy).
   */
  tenantWide: boolean;
}

const MAX_CHAIN_DEPTH = 64;
const MAX_GRID_EMPLOYEES = 1000;
const byName = (a: Employee, b: Employee) =>
  `${a.firstName} ${a.lastName}`.localeCompare(`${b.firstName} ${b.lastName}`);

/**
 * WHO a caller may schedule (step 8.2) — branch scope, then hierarchy. The same discriminator the
 * attendance-status read uses (`working_hours.manage` = tenant-wide; otherwise the reporting chain
 * of the 7.2 `User.managerId` hierarchy, with the Employee-manager fallback for people with no login).
 * Another tenant's people never appear (RLS); out-of-branch ones are a 404, never a hint.
 */
@Injectable()
export class SchedulingScopeService {
  /** Throws unless every employee exists, is in the actor's branch scope, and (for a manager) is a report. */
  async assertCanSchedule(
    tx: Prisma.TransactionClient,
    actor: SchedulingActor,
    employeeIds: string[],
  ): Promise<Employee[]> {
    const unique = [...new Set(employeeIds)];
    const employees = await tx.employee.findMany({ where: { id: { in: unique } } });
    if (employees.length !== unique.length) {
      throw new NotFoundException('One or more employees were not found.');
    }
    for (const e of employees) {
      if (actor.branchIds && !actor.branchIds.includes(e.branchId)) {
        throw new NotFoundException(`Employee "${e.id}" was not found.`);
      }
    }
    if (actor.tenantWide) return employees;

    const reports = await this.reportEmployeeIds(tx, actor.userId, employees);
    const outside = employees.filter((e) => !reports.has(e.id));
    if (outside.length > 0) {
      throw new ForbiddenException('You can only schedule people who report to you.');
    }
    return employees;
  }

  /** Which of `candidates` sit anywhere below `managerUserId` in the management chain. */
  async reportEmployeeIds(
    tx: Prisma.TransactionClient,
    managerUserId: string,
    candidates: Pick<Employee, 'id' | 'userId' | 'managerId'>[],
  ): Promise<Set<string>> {
    const reader = new DbChainReader(tx);
    const out = new Set<string>();
    for (const target of candidates) {
      if (target.userId === managerUserId) continue; // you are not your own report
      if (await this.isBelow(tx, reader, managerUserId, target)) out.add(target.id);
    }
    return out;
  }

  /**
   * Every ACTIVE employee in the actor's own reporting chain (a manager's "team"): the user-hierarchy
   * descendants, plus anyone whose Employee.managerId points at the manager or at one of those people.
   */
  async reportingChainEmployees(
    tx: Prisma.TransactionClient,
    managerUserId: string,
  ): Promise<Employee[]> {
    const users = await tx.user.findMany({ select: { id: true, managerId: true } });
    const children = new Map<string, string[]>();
    for (const u of users) {
      if (u.managerId) children.set(u.managerId, [...(children.get(u.managerId) ?? []), u.id]);
    }
    const descendantUsers = new Set<string>();
    const queue = [managerUserId];
    while (queue.length) {
      const next = queue.shift() as string;
      for (const child of children.get(next) ?? []) {
        if (!descendantUsers.has(child) && child !== managerUserId) {
          descendantUsers.add(child);
          queue.push(child);
        }
      }
    }

    const own = await tx.employee.findFirst({
      where: { userId: managerUserId },
      select: { id: true },
    });
    let managerEmployeeIds = new Set<string>(own ? [own.id] : []);
    const found = new Map<string, Employee>();
    const direct = await tx.employee.findMany({
      where: { userId: { in: [...descendantUsers] }, status: 'ACTIVE' },
    });
    for (const e of direct) found.set(e.id, e);
    for (const e of direct) managerEmployeeIds.add(e.id);

    // Employee-manager fallback (people without a login, or not linked through User.managerId); a few rounds is plenty.
    for (let round = 0; round < 4; round += 1) {
      const more = await tx.employee.findMany({
        where: {
          managerId: { in: [...managerEmployeeIds] },
          status: 'ACTIVE',
          id: { notIn: [...found.keys()] },
        },
      });
      const fresh = more.filter((e) => e.userId !== managerUserId);
      if (fresh.length === 0) break;
      for (const e of fresh) found.set(e.id, e);
      managerEmployeeIds = new Set([...managerEmployeeIds, ...fresh.map((e) => e.id)]);
    }
    return [...found.values()];
  }

  /**
   * The ACTIVE people the actor may see/schedule in a roster grid: everyone in their branch scope
   * (tenant-wide actors) or their reporting chain (managers), optionally narrowed to a team
   * (a department AND its sub-departments) and/or branch. Capped so a grid stays bounded.
   */
  async listSchedulableEmployees(
    tx: Prisma.TransactionClient,
    actor: SchedulingActor,
    filters: { departmentId?: string; branchId?: string; employeeIds?: string[] },
  ): Promise<Employee[]> {
    let departmentIds: string[] | null = null;
    if (filters.departmentId) {
      const departments = await tx.department.findMany({
        select: { id: true, parentDepartmentId: true },
        take: 20000,
      });
      const kids = new Map<string, string[]>();
      for (const d of departments)
        if (d.parentDepartmentId)
          kids.set(d.parentDepartmentId, [...(kids.get(d.parentDepartmentId) ?? []), d.id]);
      const ids = new Set<string>([filters.departmentId]);
      const queue = [filters.departmentId];
      while (queue.length)
        for (const c of kids.get(queue.shift() as string) ?? [])
          if (!ids.has(c)) {
            ids.add(c);
            queue.push(c);
          }
      departmentIds = [...ids];
    }
    const narrow = (e: Employee) =>
      (!filters.branchId || e.branchId === filters.branchId) &&
      (!departmentIds || (e.departmentId !== null && departmentIds.includes(e.departmentId))) &&
      (!filters.employeeIds || filters.employeeIds.includes(e.id)) &&
      (!actor.branchIds || actor.branchIds.includes(e.branchId));

    if (!actor.tenantWide) {
      return (await this.reportingChainEmployees(tx, actor.userId))
        .filter(narrow)
        .sort(byName)
        .slice(0, MAX_GRID_EMPLOYEES);
    }
    return tx.employee.findMany({
      where: {
        status: 'ACTIVE',
        ...(actor.branchIds ? { branchId: { in: actor.branchIds } } : {}),
        ...(filters.branchId ? { branchId: filters.branchId } : {}),
        ...(departmentIds ? { departmentId: { in: departmentIds } } : {}),
        ...(filters.employeeIds ? { id: { in: filters.employeeIds } } : {}),
      },
      orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
      take: MAX_GRID_EMPLOYEES,
    });
  }

  private async isBelow(
    tx: Prisma.TransactionClient,
    reader: DbChainReader,
    managerUserId: string,
    target: Pick<Employee, 'userId' | 'managerId'>,
  ): Promise<boolean> {
    let current: string | null = target.userId;
    if (!current && target.managerId) {
      const mgr = await tx.employee.findUnique({
        where: { id: target.managerId },
        select: { userId: true, managerId: true },
      });
      if (mgr?.userId === managerUserId) return true;
      current = mgr?.userId ?? null;
    }
    const seen = new Set<string>();
    for (let depth = 0; current && depth < MAX_CHAIN_DEPTH && !seen.has(current); depth += 1) {
      seen.add(current);
      const up = await reader.managerOf(current);
      if (up === managerUserId) return true;
      current = up;
    }
    return false;
  }
}
