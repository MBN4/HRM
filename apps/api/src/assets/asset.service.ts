import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { Asset, AssetAssignment, Prisma } from '@hrm/db';
import { AssignAssetInput, CreateAssetInput, ReturnAssetInput } from '@hrm/shared';
import { AssetCategoryService } from './asset-category.service';

/**
 * The company asset register + assignment lifecycle — see
 * docs/conventions/operations-modules.md. `Asset.status` is a denormalized
 * cache maintained here on every assign/return/maintenance transition
 * (never derived by a live join at read time — see the schema's own doc
 * comment); `AssetAssignment` is APPEND-ONLY per cycle, giving a real
 * history for free.
 */
@Injectable()
export class AssetService {
  constructor(private readonly categories: AssetCategoryService) {}

  async register(tx: Prisma.TransactionClient, tenantId: string, input: CreateAssetInput): Promise<Asset> {
    await this.categories.requireById(tx, tenantId, input.categoryId);
    return tx.asset.create({
      data: {
        tenantId,
        categoryId: input.categoryId,
        branchId: input.branchId ?? null,
        assetTag: input.assetTag,
        name: input.name,
        serialNumber: input.serialNumber ?? null,
        purchaseDate: input.purchaseDate ?? null,
        purchaseCost: input.purchaseCost ?? null,
      },
    });
  }

  async list(
    tx: Prisma.TransactionClient,
    tenantId: string,
    filters: { status?: string; categoryId?: string; branchId?: string },
    allowedBranchIds: string[] | null,
  ): Promise<Asset[]> {
    const where: Prisma.AssetWhereInput = { tenantId };
    if (filters.status) {
      where.status = filters.status as Asset['status'];
    }
    if (filters.categoryId) {
      where.categoryId = filters.categoryId;
    }
    if (filters.branchId) {
      if (allowedBranchIds && !allowedBranchIds.includes(filters.branchId)) {
        return [];
      }
      where.branchId = filters.branchId;
    } else if (allowedBranchIds) {
      where.branchId = { in: allowedBranchIds };
    }
    return tx.asset.findMany({ where, orderBy: { createdAt: 'desc' } });
  }

  async findById(tx: Prisma.TransactionClient, tenantId: string, id: string): Promise<Asset> {
    const asset = await tx.asset.findFirst({ where: { tenantId, id } });
    if (!asset) {
      throw new NotFoundException(`Asset "${id}" was not found.`);
    }
    return asset;
  }

  async assign(
    tx: Prisma.TransactionClient,
    tenantId: string,
    callerUserId: string,
    input: AssignAssetInput,
  ): Promise<AssetAssignment> {
    const asset = await this.findById(tx, tenantId, input.assetId);
    if (asset.status !== 'AVAILABLE') {
      throw new ConflictException(`Asset "${input.assetId}" is "${asset.status}" and cannot be assigned.`);
    }
    const employee = await tx.employee.findFirst({ where: { tenantId, id: input.employeeId } });
    if (!employee) {
      throw new NotFoundException(`Employee "${input.employeeId}" was not found.`);
    }

    const assignment = await tx.assetAssignment.create({
      data: {
        tenantId,
        assetId: asset.id,
        employeeId: employee.id,
        assignedByUserId: callerUserId,
        condition: input.condition ?? null,
        notes: input.notes ?? null,
      },
    });
    await tx.asset.update({ where: { id: asset.id }, data: { status: 'ASSIGNED' } });
    return assignment;
  }

  async returnAsset(
    tx: Prisma.TransactionClient,
    tenantId: string,
    assignmentId: string,
    callerUserId: string,
    input: ReturnAssetInput,
  ): Promise<AssetAssignment> {
    const assignment = await tx.assetAssignment.findFirst({ where: { tenantId, id: assignmentId } });
    if (!assignment) {
      throw new NotFoundException(`Asset assignment "${assignmentId}" was not found.`);
    }
    if (assignment.status !== 'ASSIGNED') {
      throw new ConflictException(`Asset assignment "${assignmentId}" is already "${assignment.status}".`);
    }

    const updated = await tx.assetAssignment.update({
      where: { id: assignment.id },
      data: {
        status: 'RETURNED',
        returnedAt: new Date(),
        returnedByUserId: callerUserId,
        returnCondition: input.returnCondition ?? null,
        notes: input.notes ?? assignment.notes,
      },
    });
    await tx.asset.update({ where: { id: assignment.assetId }, data: { status: 'AVAILABLE' } });
    return updated;
  }

  async listAssignmentsForAsset(tx: Prisma.TransactionClient, tenantId: string, assetId: string): Promise<AssetAssignment[]> {
    return tx.assetAssignment.findMany({ where: { tenantId, assetId }, orderBy: { assignedAt: 'desc' } });
  }

  async listAssignmentsForEmployee(
    tx: Prisma.TransactionClient,
    tenantId: string,
    employeeId: string,
  ): Promise<AssetAssignment[]> {
    return tx.assetAssignment.findMany({ where: { tenantId, employeeId }, orderBy: { assignedAt: 'desc' }, include: { asset: true } });
  }

  async listMyAssignments(tx: Prisma.TransactionClient, tenantId: string, callerUserId: string): Promise<AssetAssignment[]> {
    const own = await tx.employee.findFirst({ where: { tenantId, userId: callerUserId }, select: { id: true } });
    if (!own) {
      throw new ForbiddenException('You have no employee profile.');
    }
    return this.listAssignmentsForEmployee(tx, tenantId, own.id);
  }

  /** Used by the offboarding clearance checklist's real "asset return" wiring — see `assets.constants.ts` and `OffboardingController`. */
  async hasOutstandingAssignments(tx: Prisma.TransactionClient, tenantId: string, employeeId: string): Promise<boolean> {
    const count = await tx.assetAssignment.count({ where: { tenantId, employeeId, status: 'ASSIGNED' } });
    return count > 0;
  }

  async createMaintenanceRecord(
    tx: Prisma.TransactionClient,
    tenantId: string,
    input: { assetId: string; description: string; startedAt?: Date; cost?: number },
  ) {
    const asset = await this.findById(tx, tenantId, input.assetId);
    const record = await tx.assetMaintenanceRecord.create({
      data: {
        tenantId,
        assetId: asset.id,
        description: input.description,
        status: 'IN_PROGRESS',
        startedAt: input.startedAt ?? new Date(),
        cost: input.cost ?? null,
      },
    });
    await tx.asset.update({ where: { id: asset.id }, data: { status: 'IN_MAINTENANCE' } });
    return record;
  }

  async completeMaintenanceRecord(tx: Prisma.TransactionClient, tenantId: string, id: string, cost?: number) {
    const record = await tx.assetMaintenanceRecord.findFirst({ where: { tenantId, id } });
    if (!record) {
      throw new NotFoundException(`Maintenance record "${id}" was not found.`);
    }
    if (record.status === 'COMPLETED') {
      throw new ConflictException(`Maintenance record "${id}" is already completed.`);
    }
    const updated = await tx.assetMaintenanceRecord.update({
      where: { id: record.id },
      data: { status: 'COMPLETED', completedAt: new Date(), cost: cost ?? record.cost },
    });
    await tx.asset.update({ where: { id: record.assetId }, data: { status: 'AVAILABLE' } });
    return updated;
  }

  async listMaintenanceForAsset(tx: Prisma.TransactionClient, tenantId: string, assetId: string) {
    return tx.assetMaintenanceRecord.findMany({ where: { tenantId, assetId }, orderBy: { createdAt: 'desc' } });
  }
}
