import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import type { Prisma } from '@hrm/db';
import { SchedulingScopeService } from '../scheduling/scheduling-scope.service';
import { MAX_AUDIENCE_SIZE } from './engagement.constants';
import type { EngagementActor } from './engagement.types';

export interface AudienceMember {
  employeeId: string;
  userId: string;
  branchId: string;
}

/**
 * Resolves a survey's target audience to the people who can actually answer — ACTIVE employees
 * with a linked login. ORG = everyone; BRANCH/DEPARTMENT (a department AND its sub-departments)
 * by id; TEAM = the whole reporting chain of each named manager (the same definition
 * `SchedulingScopeService.reportingChainEmployees` uses for a manager's "team" in 8.2).
 *
 * Resolved ONCE, at publish, and snapshotted into `survey_assignments` — joining a team later
 * does not retroactively add someone to an open survey (documented, deliberate: the response
 * rate's denominator must not drift while the survey runs).
 */
@Injectable()
export class SurveyAudienceService {
  constructor(private readonly scope: SchedulingScopeService) {}

  async resolve(
    tx: Prisma.TransactionClient,
    actor: Pick<EngagementActor, 'tenantId' | 'branchIds'>,
    audienceType: 'ORG' | 'BRANCH' | 'DEPARTMENT' | 'TEAM',
    audienceIds: string[],
  ): Promise<AudienceMember[]> {
    const { tenantId } = actor;
    audienceIds = [...new Set(audienceIds)];
    const base: Prisma.EmployeeWhereInput = { tenantId, status: 'ACTIVE', userId: { not: null } };
    let employees: { id: string; userId: string | null; branchId: string }[];

    if (audienceType === 'ORG') {
      if (actor.branchIds) {
        throw new ForbiddenException('A branch-restricted user cannot publish an org-wide survey.');
      }
      employees = await tx.employee.findMany({ where: base, select: { id: true, userId: true, branchId: true }, take: MAX_AUDIENCE_SIZE });
    } else if (audienceType === 'BRANCH') {
      const branches = await tx.branch.findMany({ where: { tenantId, id: { in: audienceIds } }, select: { id: true } });
      this.assertAllFound(branches.length, audienceIds.length, 'branches');
      employees = await tx.employee.findMany({ where: { ...base, branchId: { in: audienceIds } }, select: { id: true, userId: true, branchId: true }, take: MAX_AUDIENCE_SIZE });
    } else if (audienceType === 'DEPARTMENT') {
      const departments = await tx.department.findMany({ where: { tenantId }, select: { id: true, parentDepartmentId: true } });
      const known = new Set(departments.map((d) => d.id));
      this.assertAllFound(audienceIds.filter((id) => known.has(id)).length, audienceIds.length, 'departments');
      const ids = new Set(audienceIds);
      let grew = true;
      while (grew) {
        grew = false;
        for (const d of departments) {
          if (d.parentDepartmentId && ids.has(d.parentDepartmentId) && !ids.has(d.id)) {
            ids.add(d.id);
            grew = true;
          }
        }
      }
      employees = await tx.employee.findMany({ where: { ...base, departmentId: { in: [...ids] } }, select: { id: true, userId: true, branchId: true }, take: MAX_AUDIENCE_SIZE });
    } else {
      const managers = await tx.employee.findMany({ where: { tenantId, id: { in: audienceIds } }, select: { id: true, userId: true } });
      this.assertAllFound(managers.length, audienceIds.length, 'managers');
      const found = new Map<string, { id: string; userId: string | null; branchId: string }>();
      for (const manager of managers) {
        if (!manager.userId) {
          throw new BadRequestException('A TEAM audience manager must have a login (a linked user).');
        }
        for (const member of await this.scope.reportingChainEmployees(tx, manager.userId)) {
          found.set(member.id, { id: member.id, userId: member.userId, branchId: member.branchId });
        }
      }
      employees = [...found.values()];
    }

    const members = employees.filter((e): e is { id: string; userId: string; branchId: string } => !!e.userId).map((e) => ({ employeeId: e.id, userId: e.userId, branchId: e.branchId }));
    if (actor.branchIds && members.some((m) => !actor.branchIds!.includes(m.branchId))) {
      throw new ForbiddenException('The audience includes people outside your branch scope.');
    }
    // One assignment per person even if they appear under two named teams.
    return [...new Map(members.map((m) => [m.userId, m])).values()];
  }

  private assertAllFound(found: number, wanted: number, what: string): void {
    if (found < wanted) {
      throw new BadRequestException(`One or more ${what} in the audience were not found.`);
    }
  }
}
