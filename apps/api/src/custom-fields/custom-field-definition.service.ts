import { Injectable } from '@nestjs/common';
import { Prisma } from '@hrm/db';
import type { CustomFieldDefinition } from '@hrm/db';
import type { DefineCustomFieldInput } from '@hrm/shared';

/**
 * Lets a tenant extend a core entity with its own typed fields WITHOUT a
 * schema migration — see /CLAUDE.md § Conventions → Custom fields.
 * `entityType` is a free-form string (the future "Employee", eventually
 * others) — the same polymorphic-by-string pattern `WorkflowInstance`/
 * `Notification` already use. `define` is an UPSERT keyed by
 * `(tenantId, entityType, fieldKey)`: redefining an existing field (a new
 * label, a widened `options` list, ...) replaces it in place rather than
 * erroring, the same "PUT replaces" semantics
 * `TenantCountryOverride`/`TenantFeatureFlagOverride` already use for
 * their own tenant-editable config.
 */
@Injectable()
export class CustomFieldDefinitionService {
  async define(
    tx: Prisma.TransactionClient,
    tenantId: string,
    input: DefineCustomFieldInput,
  ): Promise<CustomFieldDefinition> {
    return tx.customFieldDefinition.upsert({
      where: { tenantId_entityType_fieldKey: { tenantId, entityType: input.entityType, fieldKey: input.fieldKey } },
      create: {
        tenantId,
        entityType: input.entityType,
        fieldKey: input.fieldKey,
        label: input.label,
        fieldType: input.fieldType,
        isRequired: input.isRequired,
        options: input.options ?? undefined,
      },
      update: {
        label: input.label,
        fieldType: input.fieldType,
        isRequired: input.isRequired,
        options: input.options ?? Prisma.DbNull,
      },
    });
  }

  async list(tx: Prisma.TransactionClient, entityType: string): Promise<CustomFieldDefinition[]> {
    return tx.customFieldDefinition.findMany({ where: { entityType }, orderBy: { createdAt: 'asc' } });
  }
}
