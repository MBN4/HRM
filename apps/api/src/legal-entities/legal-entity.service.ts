import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { LegalEntity, Prisma } from '@hrm/db';
import type {
  AssignEntityBranchesInput,
  CreateLegalEntityInput,
  UpdateLegalEntityInput,
} from '@hrm/shared';
import { EncryptionService } from '../common/encryption/encryption.service';
import { StorageService } from '../storage/storage.service';
import { LegalEntityResponseDto } from './legal-entity-response.dto';
import { resolveEntityLabels, formatAddressLines } from './legal-entity-identity.util';

const MAX_LOGO_SIZE_BYTES = 2 * 1024 * 1024;
const ALLOWED_LOGO_TYPES = new Set(['image/png', 'image/jpeg', 'image/svg+xml', 'image/webp']);

/** `••••1234` — never more than the last 4 characters of a stored bank value leave the service. */
function mask(value: string): string {
  return value.length <= 4 ? '••••' : `••••${value.slice(-4)}`;
}

/**
 * Legal-entity management (`entity.manage`) — see docs/conventions/legal-entities.md. Pure IDENTITY: nothing
 * here touches Country Pack resolution (a branch's own `countryCode` still drives currency/tax/holidays).
 * Bank details are encrypted at rest with the SAME `EncryptionService` Employee's are, and only ever
 * returned masked (and only to callers holding `salary.view`, via `@RequiresPermission` on the DTO).
 */
@Injectable()
export class LegalEntityService {
  constructor(
    private readonly encryption: EncryptionService,
    private readonly storage: StorageService,
  ) {}

  async list(tx: Prisma.TransactionClient): Promise<LegalEntityResponseDto[]> {
    const rows = await tx.legalEntity.findMany({
      orderBy: [{ isDefault: 'desc' }, { legalName: 'asc' }],
    });
    const allBranches = await tx.branch.findMany({
      select: { id: true, name: true, countryCode: true, legalEntityId: true },
      orderBy: { name: 'asc' },
    });
    const labelCache = new Map<string, Awaited<ReturnType<typeof resolveEntityLabels>>>();
    const out: LegalEntityResponseDto[] = [];
    for (const row of rows) {
      if (!labelCache.has(row.countryCode)) {
        labelCache.set(row.countryCode, await resolveEntityLabels(tx, row.countryCode));
      }
      // A branch with a null link resolves to the DEFAULT entity, so it is listed (and counted) there.
      const branches = allBranches
        .filter((b) => b.legalEntityId === row.id || (row.isDefault && b.legalEntityId === null))
        .map(({ id, name, countryCode }) => ({ id, name, countryCode }));
      out.push(
        this.toDto(row, labelCache.get(row.countryCode)!, {
          branchCount: branches.length,
          branches,
        }),
      );
    }
    return out;
  }

  async get(tx: Prisma.TransactionClient, id: string): Promise<LegalEntityResponseDto> {
    const row = await this.requireRow(tx, id);
    const branches = await this.branchesOf(tx, row);
    return this.toDto(row, await resolveEntityLabels(tx, row.countryCode), {
      branchCount: branches.length,
      branches,
    });
  }

  async create(
    tx: Prisma.TransactionClient,
    tenantId: string,
    input: CreateLegalEntityInput,
  ): Promise<LegalEntityResponseDto> {
    const hasAny = await tx.legalEntity.count();
    const row = await tx.legalEntity.create({
      data: {
        tenantId,
        legalName: input.legalName,
        countryCode: input.countryCode,
        registrationNumber: input.registrationNumber ?? null,
        taxId: input.taxId ?? null,
        addressLine1: input.addressLine1 ?? null,
        addressLine2: input.addressLine2 ?? null,
        city: input.city ?? null,
        region: input.region ?? null,
        postalCode: input.postalCode ?? null,
        // The first entity a tenant ever gets is its default (what a null branch link resolves to).
        isDefault: hasAny === 0,
        ...this.encryptBank(input.bankDetails),
      },
    });
    return this.toDto(row, await resolveEntityLabels(tx, row.countryCode), { branchCount: 0 });
  }

  async update(
    tx: Prisma.TransactionClient,
    id: string,
    input: UpdateLegalEntityInput,
  ): Promise<LegalEntityResponseDto> {
    await this.requireRow(tx, id);
    const row = await tx.legalEntity.update({
      where: { id },
      data: {
        legalName: input.legalName,
        countryCode: input.countryCode,
        registrationNumber: input.registrationNumber,
        taxId: input.taxId,
        addressLine1: input.addressLine1,
        addressLine2: input.addressLine2,
        city: input.city,
        region: input.region,
        postalCode: input.postalCode,
        ...this.encryptBank(input.bankDetails),
      },
    });
    return this.get(tx, row.id);
  }

  async setDefault(tx: Prisma.TransactionClient, id: string): Promise<LegalEntityResponseDto> {
    await this.requireRow(tx, id);
    // Two statements in one request transaction; the partial unique index guarantees one default.
    await tx.legalEntity.updateMany({
      where: { isDefault: true, id: { not: id } },
      data: { isDefault: false },
    });
    await tx.legalEntity.update({ where: { id }, data: { isDefault: true } });
    return this.get(tx, id);
  }

  /** Deleting is refused while any branch still points at the entity (FK Restrict) or if it is the default. */
  async remove(tx: Prisma.TransactionClient, id: string): Promise<{ deleted: true }> {
    const row = await this.requireRow(tx, id);
    if (row.isDefault) {
      throw new ConflictException(
        'The default legal entity cannot be deleted — make another entity the default first.',
      );
    }
    const branchCount = await tx.branch.count({ where: { legalEntityId: id } });
    const reportCount = await tx.generatedReport.count({ where: { legalEntityId: id } });
    const runCount = await tx.payrollRun.count({ where: { legalEntityId: id } });
    if (branchCount > 0 || reportCount > 0 || runCount > 0) {
      throw new ConflictException(
        'This legal entity still has branches, payroll runs or statutory reports attached and cannot be deleted.',
      );
    }
    await tx.legalEntity.delete({ where: { id } });
    return { deleted: true };
  }

  /** Moves the given branches onto this entity (a branch belongs to exactly one). */
  async assignBranches(
    tx: Prisma.TransactionClient,
    id: string,
    input: AssignEntityBranchesInput,
  ): Promise<LegalEntityResponseDto> {
    await this.requireRow(tx, id);
    const found = await tx.branch.findMany({
      where: { id: { in: input.branchIds } },
      select: { id: true },
    });
    if (found.length !== new Set(input.branchIds).size) {
      throw new BadRequestException('One or more branches were not found.');
    }
    await tx.branch.updateMany({
      where: { id: { in: input.branchIds } },
      data: { legalEntityId: id },
    });
    return this.get(tx, id);
  }

  /** Employees whose branch belongs to this entity (an employee's entity is DERIVED from their branch). */
  async listEmployees(tx: Prisma.TransactionClient, id: string, allowedBranchIds: string[] | null) {
    const entity = await this.requireRow(tx, id);
    const branchIds = (await this.branchesOf(tx, entity))
      .map((b) => b.id)
      .filter((b) => !allowedBranchIds || allowedBranchIds.includes(b));
    const employees = await tx.employee.findMany({
      where: { branchId: { in: branchIds } },
      select: {
        id: true,
        employeeCode: true,
        firstName: true,
        lastName: true,
        status: true,
        branchId: true,
        branch: { select: { name: true } },
      },
      orderBy: { employeeCode: 'asc' },
      take: 500,
    });
    return employees.map((e) => ({
      id: e.id,
      employeeCode: e.employeeCode,
      name: `${e.firstName} ${e.lastName}`,
      status: e.status,
      branchId: e.branchId,
      branchName: e.branch.name,
    }));
  }

  async uploadLogo(
    tx: Prisma.TransactionClient,
    tenantId: string,
    id: string,
    file: { buffer: Buffer; mimetype: string; size: number; originalname: string },
  ): Promise<LegalEntityResponseDto> {
    await this.requireRow(tx, id);
    if (!ALLOWED_LOGO_TYPES.has(file.mimetype)) {
      throw new BadRequestException('Logo must be a PNG, JPEG, SVG or WebP image.');
    }
    if (file.size > MAX_LOGO_SIZE_BYTES) {
      throw new BadRequestException('Logo must be 2 MB or smaller.');
    }
    const key = `legal-entities/${tenantId}/${id}/logo-${randomUUID()}`;
    await this.storage.uploadObject({ key, body: file.buffer, contentType: file.mimetype });
    await tx.legalEntity.update({ where: { id }, data: { logoStorageKey: key } });
    return this.get(tx, id);
  }

  async downloadLogo(tx: Prisma.TransactionClient, id: string) {
    const row = await this.requireRow(tx, id);
    if (!row.logoStorageKey) {
      throw new NotFoundException('This legal entity has no logo.');
    }
    return this.storage.downloadObject(row.logoStorageKey);
  }

  private async requireRow(tx: Prisma.TransactionClient, id: string): Promise<LegalEntity> {
    const row = await tx.legalEntity.findUnique({ where: { id } });
    if (!row) {
      throw new NotFoundException(`Legal entity "${id}" was not found.`);
    }
    return row;
  }

  /** Branches linked to the entity; for the DEFAULT entity this also includes branches with a null link (they resolve to it). */
  private async branchesOf(tx: Prisma.TransactionClient, entity: LegalEntity) {
    return tx.branch.findMany({
      where: entity.isDefault
        ? { OR: [{ legalEntityId: entity.id }, { legalEntityId: null }] }
        : { legalEntityId: entity.id },
      select: { id: true, name: true, countryCode: true },
      orderBy: { name: 'asc' },
    });
  }

  private encryptBank(bank: CreateLegalEntityInput['bankDetails']) {
    if (bank === undefined) {
      return {};
    }
    if (bank === null) {
      return {
        bankNameEncrypted: null,
        bankAccountNumberEncrypted: null,
        bankRoutingCodeEncrypted: null,
      };
    }
    return {
      bankNameEncrypted: this.encryption.encrypt(bank.bankName),
      bankAccountNumberEncrypted: this.encryption.encrypt(bank.accountNumber),
      bankRoutingCodeEncrypted: bank.routingCode ? this.encryption.encrypt(bank.routingCode) : null,
    };
  }

  private toDto(
    row: LegalEntity,
    labels: { registrationNumberLabel: string; taxIdLabel: string },
    extra: { branchCount: number; branches?: { id: string; name: string; countryCode: string }[] },
  ): LegalEntityResponseDto {
    const hasBank = Boolean(row.bankAccountNumberEncrypted);
    return new LegalEntityResponseDto({
      id: row.id,
      legalName: row.legalName,
      countryCode: row.countryCode,
      registrationNumber: row.registrationNumber,
      taxId: row.taxId,
      registrationNumberLabel: labels.registrationNumberLabel,
      taxIdLabel: labels.taxIdLabel,
      addressLine1: row.addressLine1,
      addressLine2: row.addressLine2,
      city: row.city,
      region: row.region,
      postalCode: row.postalCode,
      addressLines: formatAddressLines(row),
      hasLogo: Boolean(row.logoStorageKey),
      isDefault: row.isDefault,
      hasBankDetails: hasBank,
      bankDetails: hasBank
        ? {
            bankName: row.bankNameEncrypted ? this.encryption.decrypt(row.bankNameEncrypted) : null,
            accountNumberMasked: mask(this.encryption.decrypt(row.bankAccountNumberEncrypted!)),
            routingCodeMasked: row.bankRoutingCodeEncrypted
              ? mask(this.encryption.decrypt(row.bankRoutingCodeEncrypted))
              : null,
          }
        : null,
      branchCount: extra.branchCount,
      branches: extra.branches,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    });
  }
}
