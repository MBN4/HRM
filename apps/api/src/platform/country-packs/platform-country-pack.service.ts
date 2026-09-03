import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { prisma } from '@hrm/db';
import {
  countryPackConfigSchema,
  type CountryPackConfig,
  type CreateCountryPackInput,
  type CreateCountryPackVersionInput,
  type UpdateCountryPackVersionInput,
} from '@hrm/shared';
import { PlatformAuditRecordService } from '../audit/platform-audit-record.service';

export interface CountryPackVersionSummary {
  id: string;
  countryCode: string;
  version: number;
  isActive: boolean;
  config: CountryPackConfig;
  createdAt: string;
  updatedAt: string;
}

function toSummary(pack: {
  id: string;
  countryCode: string;
  version: number;
  isActive: boolean;
  config: unknown;
  createdAt: Date;
  updatedAt: Date;
}): CountryPackVersionSummary {
  return {
    id: pack.id,
    countryCode: pack.countryCode,
    version: pack.version,
    isActive: pack.isActive,
    // Re-validated on every READ, not just trusted from the JSON column —
    // this project's consistent "no single layer trusted alone" posture
    // for JSON-configured features (see docs/conventions/country-packs.md).
    config: countryPackConfigSchema.parse(pack.config),
    createdAt: pack.createdAt.toISOString(),
    updatedAt: pack.updatedAt.toISOString(),
  };
}

/**
 * Country Pack authoring/versioning — THE vendor's saleable-asset
 * workshop (step 4.1). Reuses `@hrm/shared`'s `countryPackConfigSchema`
 * (0.5) as-is for validation on every write AND on activation — this
 * module is CRUD/lifecycle around the EXISTING pack schema/resolution
 * engine, never a rebuild of it (see docs/conventions/country-packs.md —
 * `CountryPackResolutionService` and the rules engine are completely
 * untouched by this step).
 */
@Injectable()
export class PlatformCountryPackService {
  constructor(private readonly audit: PlatformAuditRecordService) {}

  async listCountries(): Promise<{ countryCode: string; versions: CountryPackVersionSummary[] }[]> {
    const rows = await prisma.countryPack.findMany({ orderBy: [{ countryCode: 'asc' }, { version: 'asc' }] });
    const byCountry = new Map<string, CountryPackVersionSummary[]>();
    for (const row of rows) {
      const summary = toSummary(row);
      const list = byCountry.get(summary.countryCode) ?? [];
      list.push(summary);
      byCountry.set(summary.countryCode, list);
    }
    return Array.from(byCountry.entries()).map(([countryCode, versions]) => ({ countryCode, versions }));
  }

  async listVersions(countryCode: string): Promise<CountryPackVersionSummary[]> {
    const rows = await prisma.countryPack.findMany({
      where: { countryCode: countryCode.toUpperCase() },
      orderBy: { version: 'asc' },
    });
    if (rows.length === 0) {
      throw new NotFoundException(`No Country Pack exists for "${countryCode}".`);
    }
    return rows.map(toSummary);
  }

  async create(actorId: string, input: CreateCountryPackInput): Promise<CountryPackVersionSummary> {
    const countryCode = input.countryCode.toUpperCase();
    const existing = await prisma.countryPack.findFirst({ where: { countryCode } });
    if (existing) {
      throw new ConflictException(
        `A Country Pack already exists for "${countryCode}" — use POST /platform/country-packs/${countryCode}/versions to add a new version instead.`,
      );
    }

    // The FIRST version of a brand-new country may activate immediately —
    // there is no existing active config it could clobber. Every
    // SUBSEQUENT version (see createVersion below) defaults to a draft
    // instead, forcing the explicit "author, then activate" workflow this
    // step's brief calls for.
    const pack = await prisma.countryPack.create({
      data: { countryCode, version: 1, isActive: true, config: input.config },
    });

    await this.audit.record({
      platformAdminId: actorId,
      action: 'platform.country_pack.created',
      entityType: 'CountryPack',
      entityId: pack.id,
      after: { countryCode, version: 1 },
    });

    return toSummary(pack);
  }

  async createVersion(actorId: string, countryCode: string, input: CreateCountryPackVersionInput): Promise<CountryPackVersionSummary> {
    const code = countryCode.toUpperCase();
    const versions = await prisma.countryPack.findMany({ where: { countryCode: code }, orderBy: { version: 'desc' } });
    if (versions.length === 0) {
      throw new NotFoundException(`No Country Pack exists for "${code}" — create one first.`);
    }
    const active = versions.find((v) => v.isActive) ?? versions[0];
    const nextVersion = versions[0].version + 1;
    const config = input.config ?? countryPackConfigSchema.parse(active.config);

    const pack = await prisma.countryPack.create({
      data: { countryCode: code, version: nextVersion, isActive: false, config },
    });

    await this.audit.record({
      platformAdminId: actorId,
      action: 'platform.country_pack.version_created',
      entityType: 'CountryPack',
      entityId: pack.id,
      after: { countryCode: code, version: nextVersion, clonedFromVersion: input.config ? null : active.version },
    });

    return toSummary(pack);
  }

  async updateVersion(
    actorId: string,
    countryCode: string,
    version: number,
    input: UpdateCountryPackVersionInput,
  ): Promise<CountryPackVersionSummary> {
    const code = countryCode.toUpperCase();
    const pack = await this.requireVersion(code, version);
    if (pack.isActive) {
      throw new BadRequestException(
        'Cannot edit an ACTIVE Country Pack version in place — create a new draft version instead (POST .../versions).',
      );
    }

    const updated = await prisma.countryPack.update({ where: { id: pack.id }, data: { config: input.config } });

    await this.audit.record({
      platformAdminId: actorId,
      action: 'platform.country_pack.version_edited',
      entityType: 'CountryPack',
      entityId: updated.id,
      before: { config: pack.config },
      after: { config: input.config },
    });

    return toSummary(updated);
  }

  /**
   * Activation is the "well-formed before activation" gate this step's
   * brief calls for: `countryPackConfigSchema.parse` runs again here —
   * defense-in-depth on top of the schema already having validated the
   * SAME config at write time (create/createVersion/updateVersion all
   * already reject a malformed payload as a 400 via the route's own
   * `ZodValidationPipe`) — before flipping this version active and every
   * sibling version for the same country inactive, in one transaction.
   */
  async activate(actorId: string, countryCode: string, version: number): Promise<CountryPackVersionSummary> {
    const code = countryCode.toUpperCase();
    const pack = await this.requireVersion(code, version);

    const parsed = countryPackConfigSchema.safeParse(pack.config);
    if (!parsed.success) {
      throw new BadRequestException(`Cannot activate a malformed Country Pack config: ${parsed.error.message}`);
    }

    const [, activated] = await prisma.$transaction([
      prisma.countryPack.updateMany({ where: { countryCode: code, isActive: true }, data: { isActive: false } }),
      prisma.countryPack.update({ where: { id: pack.id }, data: { isActive: true } }),
    ]);

    await this.audit.record({
      platformAdminId: actorId,
      action: 'platform.country_pack.activated',
      entityType: 'CountryPack',
      entityId: activated.id,
      after: { countryCode: code, version },
    });

    return toSummary(activated);
  }

  private async requireVersion(countryCode: string, version: number) {
    const pack = await prisma.countryPack.findUnique({ where: { countryCode_version: { countryCode, version } } });
    if (!pack) {
      throw new NotFoundException(`No Country Pack version ${version} exists for "${countryCode}".`);
    }
    return pack;
  }
}
