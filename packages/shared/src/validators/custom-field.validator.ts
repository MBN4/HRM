import { z } from 'zod';

export const CUSTOM_FIELD_TYPES = ['STRING', 'NUMBER', 'DATE', 'BOOLEAN', 'ENUM'] as const;
export type CustomFieldTypeKey = (typeof CUSTOM_FIELD_TYPES)[number];

const FIELD_KEY_PATTERN = /^[a-z][a-z0-9_]*$/;

/**
 * `POST /custom-fields/definitions` body. `options` is required (and
 * non-empty) exactly when `fieldType` is `ENUM`, and rejected otherwise —
 * the same "no meaningless combination accepted" posture
 * `tenantCountryOverrideSchema` (0.5) and `licensePayloadSchema` (0.6)
 * already enforce via `.strict()`/`.refine()`.
 */
export const defineCustomFieldSchema = z
  .object({
    entityType: z.string().min(1).max(100),
    fieldKey: z
      .string()
      .min(1)
      .max(100)
      .regex(FIELD_KEY_PATTERN, 'fieldKey must be snake_case, starting with a lowercase letter (e.g. "shirt_size")'),
    label: z.string().min(1).max(200),
    fieldType: z.enum(CUSTOM_FIELD_TYPES),
    isRequired: z.boolean().default(false),
    options: z.array(z.string().min(1)).min(1).max(100).optional(),
  })
  .strict()
  .refine((v) => v.fieldType !== 'ENUM' || (v.options && v.options.length > 0), {
    message: 'options is required (and must be non-empty) when fieldType is "ENUM"',
    path: ['options'],
  })
  .refine((v) => v.fieldType === 'ENUM' || v.options === undefined, {
    message: 'options is only valid when fieldType is "ENUM"',
    path: ['options'],
  });
export type DefineCustomFieldInput = z.infer<typeof defineCustomFieldSchema>;

/**
 * `PUT /custom-fields/values/:entityType/:entityId` body — an arbitrary
 * `{ [fieldKey]: value }` map, deliberately unconstrained by zod beyond
 * "an object of unknown values": the REAL validation (which keys are
 * legal, per-field type-checking, required fields present, ENUM values
 * within `options`) depends on that tenant's current
 * `CustomFieldDefinition` rows for the entity type, which zod alone can't
 * see — see `CustomFieldValueService.setValues`.
 */
export const setCustomFieldValuesSchema = z.record(z.string(), z.unknown());
export type SetCustomFieldValuesInput = z.infer<typeof setCustomFieldValuesSchema>;
