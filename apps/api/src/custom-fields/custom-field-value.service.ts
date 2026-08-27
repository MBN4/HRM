import { BadRequestException, Injectable } from '@nestjs/common';
import type { CustomFieldDefinition, Prisma } from '@hrm/db';
import { Prisma as PrismaNamespace } from '@hrm/db';
import type { SetCustomFieldValuesInput } from '@hrm/shared';
import { CustomFieldDefinitionService } from './custom-field-definition.service';

export interface CustomFieldValueSetDto {
  entityType: string;
  entityId: string;
  values: Record<string, unknown>;
}

function describeExpectedType(def: CustomFieldDefinition): string {
  switch (def.fieldType) {
    case 'STRING':
      return 'a string';
    case 'NUMBER':
      return 'a finite number';
    case 'BOOLEAN':
      return 'a boolean';
    case 'DATE':
      return 'an ISO-8601 date string';
    case 'ENUM': {
      const options = Array.isArray(def.options) ? (def.options as unknown[]) : [];
      return `one of: ${options.join(', ')}`;
    }
    default:
      return 'a valid value';
  }
}

function isValidForType(def: CustomFieldDefinition, value: unknown): boolean {
  switch (def.fieldType) {
    case 'STRING':
      return typeof value === 'string';
    case 'NUMBER':
      return typeof value === 'number' && Number.isFinite(value);
    case 'BOOLEAN':
      return typeof value === 'boolean';
    case 'DATE':
      return typeof value === 'string' && !Number.isNaN(Date.parse(value));
    case 'ENUM': {
      const options = Array.isArray(def.options) ? (def.options as unknown[]) : [];
      return typeof value === 'string' && options.includes(value);
    }
    default:
      return false;
  }
}

/**
 * The value side of custom fields — see `custom-field-definition.service.ts`
 * and /CLAUDE.md § Conventions → Custom fields. `setValues` takes FULL
 * REPLACE semantics (the same "PUT replaces the whole resource" contract
 * `TenantCountryOverride`/`TenantFeatureFlagOverride` already use): the
 * body must satisfy every `isRequired` field on its own, not merged with
 * whatever was previously stored — simpler to reason about than a partial
 * PATCH, and matches how every other tenant-editable JSON config in this
 * codebase is written.
 *
 * Re-validates against the entity type's CURRENT `CustomFieldDefinition`
 * rows on every write — same "JSON column has no schema-level guarantee of
 * its own" posture as Country Pack config / workflow approver rules /
 * everything else JSON-configured in this system.
 *
 * A future real entity module (Employee, ...) is expected to call
 * `getValues` and spread its `values` into that entity's own response DTO,
 * and `setValues` from its own create/update handler — this service has no
 * opinion on, or dependency on, what the "real" entity table looks like,
 * matching the same polymorphic-by-string design `WorkflowInstance`/
 * `Notification` already use for the same reason.
 */
@Injectable()
export class CustomFieldValueService {
  constructor(private readonly definitions: CustomFieldDefinitionService) {}

  async setValues(
    tx: Prisma.TransactionClient,
    tenantId: string,
    entityType: string,
    entityId: string,
    rawValues: SetCustomFieldValuesInput,
  ): Promise<CustomFieldValueSetDto> {
    const defs = await this.definitions.list(tx, entityType);
    const defsByKey = new Map(defs.map((def) => [def.fieldKey, def]));

    const unknownKeys = Object.keys(rawValues).filter((key) => !defsByKey.has(key));
    if (unknownKeys.length > 0) {
      throw new BadRequestException(
        `Unknown custom field key(s) for entity type "${entityType}": ${unknownKeys.join(', ')}.`,
      );
    }

    for (const def of defs) {
      const value = rawValues[def.fieldKey];
      if (value === undefined || value === null) {
        if (def.isRequired) {
          throw new BadRequestException(`Custom field "${def.fieldKey}" is required for entity type "${entityType}".`);
        }
        continue;
      }
      if (!isValidForType(def, value)) {
        throw new BadRequestException(
          `Custom field "${def.fieldKey}" must be ${describeExpectedType(def)}, got: ${JSON.stringify(value)}.`,
        );
      }
    }

    const row = await tx.customFieldValueSet.upsert({
      where: { tenantId_entityType_entityId: { tenantId, entityType, entityId } },
      create: { tenantId, entityType, entityId, values: rawValues as PrismaNamespace.InputJsonValue },
      update: { values: rawValues as PrismaNamespace.InputJsonValue },
    });

    return { entityType, entityId, values: row.values as Record<string, unknown> };
  }

  /**
   * `findFirst` rather than the compound-unique `findUnique` — RLS already
   * scopes every row to the caller's tenant (see `withTenantContext`), so
   * `entityType` + `entityId` alone is enough to identify the row within
   * that scope without the caller needing to supply `tenantId` again.
   */
  async getValues(tx: Prisma.TransactionClient, entityType: string, entityId: string): Promise<CustomFieldValueSetDto> {
    const row = await tx.customFieldValueSet.findFirst({ where: { entityType, entityId } });
    return { entityType, entityId, values: (row?.values as Record<string, unknown>) ?? {} };
  }
}
