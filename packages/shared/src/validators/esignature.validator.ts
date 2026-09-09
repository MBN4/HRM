import { z } from 'zod';

/**
 * The e-signature module's schema (step 3.5.3) — see
 * docs/conventions/e-signatures.md. `entityType` (like
 * `WorkflowInstance.entityType`/`CustomFieldDefinition.entityType`) is a
 * free-form string, never a closed enum here — this module has no fixed
 * catalog of "things that can be signed"; `'Offer'`/`'Policy'` are just the
 * two integrations this step actually wires up.
 */

export const SIGNER_TYPES = ['INTERNAL', 'EXTERNAL'] as const;
export type SignerTypeKey = (typeof SIGNER_TYPES)[number];

export const SIGNING_METHODS = ['TYPED_NAME', 'DRAWN_SIGNATURE', 'CLICK_TO_SIGN'] as const;
export type SigningMethodKey = (typeof SIGNING_METHODS)[number];

const internalSignerSchema = z
  .object({
    signerType: z.literal('INTERNAL'),
    order: z.number().int().min(0).default(0),
    userId: z.string().uuid(),
  })
  .strict();

const externalSignerSchema = z
  .object({
    signerType: z.literal('EXTERNAL'),
    order: z.number().int().min(0).default(0),
    externalName: z.string().min(1).max(200),
    externalEmail: z.string().email(),
  })
  .strict();

/** One entry per signer — see docs/conventions/e-signatures.md → Sequencing for what `order` means (shares a value = parallel group, differs = sequential). */
export const signerInputSchema = z.discriminatedUnion('signerType', [internalSignerSchema, externalSignerSchema]);
export type SignerInput = z.infer<typeof signerInputSchema>;

const generateOfferLetterSchema = z.object({ kind: z.literal('OFFER_LETTER'), offerId: z.string().uuid() }).strict();
const generatePolicySchema = z.object({ kind: z.literal('POLICY'), policyId: z.string().uuid() }).strict();
const generateCustomSchema = z
  .object({
    kind: z.literal('CUSTOM'),
    title: z.string().min(1).max(200),
    paragraphs: z.array(z.string().min(1).max(4000)).min(1).max(200),
  })
  .strict();

/** `GENERATED`-source documents — a small, closed set of renderers this step actually builds (see `SignableDocumentPdfService`); a real future document type is a new discriminated-union member, not a schema redesign. */
export const generateDocumentInputSchema = z.discriminatedUnion('kind', [
  generateOfferLetterSchema,
  generatePolicySchema,
  generateCustomSchema,
]);
export type GenerateDocumentInput = z.infer<typeof generateDocumentInputSchema>;

export const createGeneratedSignatureRequestSchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    entityType: z.string().min(1).max(100).optional(),
    entityId: z.string().uuid().optional(),
    branchId: z.string().uuid().optional(),
    generate: generateDocumentInputSchema,
    signers: z.array(signerInputSchema).min(1).max(20),
    expiresInDays: z.number().int().min(1).max(180).default(14),
  })
  .strict();
export type CreateGeneratedSignatureRequestInput = z.infer<typeof createGeneratedSignatureRequestSchema>;

/**
 * The UPLOADED-source create route is multipart (a real file, not JSON) —
 * `signers` arrives as a JSON-encoded STRING form field (the same "binary
 * content doesn't fit a JSON string, but everything else that CAN be JSON
 * stays JSON" posture 1.1's document upload / the bulk-import CSV-as-a-
 * JSON-string-field convention already establish), parsed and re-validated
 * against `z.array(signerInputSchema)` by the controller before use.
 */
export const createUploadedSignatureRequestFieldsSchema = z
  .object({
    title: z.string().min(1).max(200),
    entityType: z.string().min(1).max(100).optional(),
    entityId: z.string().uuid().optional(),
    branchId: z.string().uuid().optional(),
    signersJson: z.string().min(1),
    expiresInDays: z.coerce.number().int().min(1).max(180).default(14),
  })
  .strict();
export type CreateUploadedSignatureRequestFields = z.infer<typeof createUploadedSignatureRequestFieldsSchema>;

export const signersArraySchema = z.array(signerInputSchema).min(1).max(20);

const typedSignatureSchema = z
  .object({
    signingMethod: z.literal('TYPED_NAME'),
    typedSignatureText: z.string().min(1).max(200),
    consent: z.literal(true),
  })
  .strict();
const drawnSignatureSchema = z
  .object({
    signingMethod: z.literal('DRAWN_SIGNATURE'),
    // A `data:image/png;base64,...` (or bare base64) capture from a
    // `<canvas>` signature pad — decoded and stored via `StorageService`,
    // never persisted inline in the DB.
    signatureImageBase64: z.string().min(1),
    consent: z.literal(true),
  })
  .strict();
const clickToSignSchema = z
  .object({
    signingMethod: z.literal('CLICK_TO_SIGN'),
    consent: z.literal(true),
  })
  .strict();

/** `consent` must be explicitly `true` — a signer affirmatively agreeing to sign, captured as its own field on the evidentiary record's `metadata`, never inferred from merely calling the route. */
export const signDocumentSchema = z.discriminatedUnion('signingMethod', [
  typedSignatureSchema,
  drawnSignatureSchema,
  clickToSignSchema,
]);
export type SignDocumentInput = z.infer<typeof signDocumentSchema>;

export const declineSignatureSchema = z.object({ reason: z.string().max(2000).optional() }).strict();
export type DeclineSignatureInput = z.infer<typeof declineSignatureSchema>;
