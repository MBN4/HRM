import { z } from 'zod';

/**
 * Multi-legal-entity identity (step 12.1) — see docs/conventions/legal-entities.md. A legal entity is a
 * registered company a tenant's branches belong to. `registrationNumber`/`taxId` are generic fields;
 * the per-country LABEL ("Company Registration No." / "NTN" / "EIN"...) comes from the Country Pack
 * (`legalEntity` section) with the fallback below.
 */
export const DEFAULT_REGISTRATION_NUMBER_LABEL = 'Registration number';
export const DEFAULT_TAX_ID_LABEL = 'Tax ID';

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional();

export const legalEntityBankDetailsSchema = z
  .object({
    bankName: z.string().trim().min(1).max(120),
    accountNumber: z.string().trim().min(1).max(64),
    routingCode: z.string().trim().max(64).nullable().optional(),
  })
  .strict();
export type LegalEntityBankDetailsInput = z.infer<typeof legalEntityBankDetailsSchema>;

const entityFields = {
  legalName: z.string().trim().min(1).max(200),
  countryCode: z
    .string()
    .trim()
    .length(2)
    .transform((v) => v.toUpperCase()),
  registrationNumber: optionalText(80),
  taxId: optionalText(80),
  addressLine1: optionalText(200),
  addressLine2: optionalText(200),
  city: optionalText(100),
  region: optionalText(100),
  postalCode: optionalText(32),
  /** `null` clears stored bank details; omitted leaves them untouched. */
  bankDetails: legalEntityBankDetailsSchema.nullable().optional(),
};

export const createLegalEntitySchema = z.object(entityFields).strict();
export type CreateLegalEntityInput = z.infer<typeof createLegalEntitySchema>;

export const updateLegalEntitySchema = z
  .object({
    ...entityFields,
    legalName: entityFields.legalName.optional(),
    countryCode: entityFields.countryCode.optional(),
  })
  .strict();
export type UpdateLegalEntityInput = z.infer<typeof updateLegalEntitySchema>;

/** Assign branches to an entity (a branch belongs to exactly one entity — assigning moves it). */
export const assignEntityBranchesSchema = z
  .object({ branchIds: z.array(z.string().uuid()).min(1).max(500) })
  .strict();
export type AssignEntityBranchesInput = z.infer<typeof assignEntityBranchesSchema>;
