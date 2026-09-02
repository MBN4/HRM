import { Injectable, NotFoundException } from '@nestjs/common';
import type { Announcement, Prisma } from '@hrm/db';
import { CreateAnnouncementInput } from '@hrm/shared';

/**
 * Announcements — see docs/conventions/operations-modules.md. Targeted by
 * branch/department; an EMPTY `targetBranchIds`/`targetDepartmentIds`
 * means every branch/department (no restriction) — see the schema's own
 * doc comment. Wires the ESS "announcements seam" left as a placeholder
 * in 1.4 to real, tenant-authored data for the first time.
 */
@Injectable()
export class AnnouncementService {
  async create(tx: Prisma.TransactionClient, tenantId: string, callerUserId: string, input: CreateAnnouncementInput): Promise<Announcement> {
    return tx.announcement.create({
      data: {
        tenantId,
        title: input.title,
        body: input.body,
        publishedByUserId: callerUserId,
        targetBranchIds: input.targetBranchIds,
        targetDepartmentIds: input.targetDepartmentIds,
        publishedAt: input.publish ? new Date() : null,
      },
    });
  }

  async publish(tx: Prisma.TransactionClient, tenantId: string, id: string): Promise<Announcement> {
    const announcement = await this.requireById(tx, tenantId, id);
    if (announcement.publishedAt) {
      return announcement;
    }
    return tx.announcement.update({ where: { id: announcement.id }, data: { publishedAt: new Date() } });
  }

  async deactivate(tx: Prisma.TransactionClient, tenantId: string, id: string): Promise<Announcement> {
    const announcement = await this.requireById(tx, tenantId, id);
    return tx.announcement.update({ where: { id: announcement.id }, data: { isActive: false } });
  }

  async listForAdmin(tx: Prisma.TransactionClient, tenantId: string): Promise<Announcement[]> {
    return tx.announcement.findMany({ where: { tenantId }, orderBy: { createdAt: 'desc' } });
  }

  /**
   * The ESS read: every ACTIVE, PUBLISHED announcement targeted at the
   * caller — resolved from their own linked `Employee`'s branch/
   * department. A caller with no `Employee` record (an admin-only account)
   * sees only fully-untargeted announcements, the same "your own data is
   * never out of scope, but there's no scope to widen into without an
   * Employee record" posture this codebase already takes elsewhere.
   */
  async listForCaller(tx: Prisma.TransactionClient, tenantId: string, callerUserId: string): Promise<Announcement[]> {
    const own = await tx.employee.findFirst({ where: { tenantId, userId: callerUserId }, select: { branchId: true, departmentId: true } });
    const all = await tx.announcement.findMany({
      where: { tenantId, isActive: true, publishedAt: { not: null } },
      orderBy: { publishedAt: 'desc' },
    });
    return all.filter((announcement) => {
      const branchOk = announcement.targetBranchIds.length === 0 || (!!own && announcement.targetBranchIds.includes(own.branchId));
      const departmentOk =
        announcement.targetDepartmentIds.length === 0 || (!!own?.departmentId && announcement.targetDepartmentIds.includes(own.departmentId));
      return branchOk && departmentOk;
    });
  }

  private async requireById(tx: Prisma.TransactionClient, tenantId: string, id: string): Promise<Announcement> {
    const announcement = await tx.announcement.findFirst({ where: { tenantId, id } });
    if (!announcement) {
      throw new NotFoundException(`Announcement "${id}" was not found.`);
    }
    return announcement;
  }
}
