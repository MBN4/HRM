import type { LegalEntity, Prisma } from '@hrm/db';
import {
  DEFAULT_REGISTRATION_NUMBER_LABEL,
  DEFAULT_TAX_ID_LABEL,
  legalEntityPackSchema,
} from '@hrm/shared';

/**
 * The PUBLIC, document-safe face of a legal entity — exactly what a payslip / statutory report / offer
 * letter prints as the employer. Deliberately carries NO bank details and no storage keys: a compliance
 * document must never be able to leak them. See docs/conventions/legal-entities.md.
 */
export interface LegalEntityIdentity {
  id: string;
  legalName: string;
  countryCode: string;
  registrationNumber: string | null;
  taxId: string | null;
  registrationNumberLabel: string;
  taxIdLabel: string;
  /** Non-empty address lines in print order (line1, line2, "city, region postal"). */
  addressLines: string[];
  hasLogo: boolean;
  isDefault: boolean;
}

/** Per-country labels for the generic registration/tax fields, from the active Country Pack (generic fallback). */
export async function resolveEntityLabels(
  tx: Prisma.TransactionClient,
  countryCode: string,
): Promise<{ registrationNumberLabel: string; taxIdLabel: string }> {
  const pack = await tx.countryPack.findFirst({
    where: { countryCode, isActive: true },
    orderBy: { version: 'desc' },
    select: { config: true },
  });
  const raw = (pack?.config as { legalEntity?: unknown } | null | undefined)?.legalEntity;
  const parsed = legalEntityPackSchema.safeParse(raw);
  return parsed.success
    ? {
        registrationNumberLabel: parsed.data.registrationNumberLabel,
        taxIdLabel: parsed.data.taxIdLabel,
      }
    : {
        registrationNumberLabel: DEFAULT_REGISTRATION_NUMBER_LABEL,
        taxIdLabel: DEFAULT_TAX_ID_LABEL,
      };
}

export function formatAddressLines(
  entity: Pick<LegalEntity, 'addressLine1' | 'addressLine2' | 'city' | 'region' | 'postalCode'>,
): string[] {
  const cityLine = [[entity.city, entity.region].filter(Boolean).join(', '), entity.postalCode]
    .filter(Boolean)
    .join(' ');
  return [entity.addressLine1, entity.addressLine2, cityLine].filter((line): line is string =>
    Boolean(line && line.trim()),
  );
}

export async function toLegalEntityIdentity(
  tx: Prisma.TransactionClient,
  entity: LegalEntity,
): Promise<LegalEntityIdentity> {
  const labels = await resolveEntityLabels(tx, entity.countryCode);
  return {
    id: entity.id,
    legalName: entity.legalName,
    countryCode: entity.countryCode,
    registrationNumber: entity.registrationNumber,
    taxId: entity.taxId,
    ...labels,
    addressLines: formatAddressLines(entity),
    hasLogo: Boolean(entity.logoStorageKey),
    isDefault: entity.isDefault,
  };
}

/**
 * THE one place "which legal entity does this branch belong to?" is answered: the branch's own
 * `legalEntityId`, else the tenant's DEFAULT entity (so a pre-12.1 branch/fixture with a null link
 * still resolves), else `null` (a tenant with no entity at all — callers fall back to the tenant name,
 * i.e. exactly the pre-12.1 behaviour). A plain `(tx, ...)` function — not a request-scoped service —
 * so the context-less BullMQ processors (payroll, statutory reporting) can call it too, the SAME reason
 * `resolvePayrollPackConfig` is shaped this way. An employee's entity is their branch's entity.
 */
export async function findEntityForBranch(
  tx: Prisma.TransactionClient,
  tenantId: string,
  branchId: string,
): Promise<LegalEntity | null> {
  const branch = await tx.branch.findUnique({
    where: { id: branchId },
    select: { legalEntityId: true },
  });
  if (branch?.legalEntityId) {
    const linked = await tx.legalEntity.findUnique({ where: { id: branch.legalEntityId } });
    if (linked) {
      return linked;
    }
  }
  return tx.legalEntity.findFirst({ where: { tenantId, isDefault: true } });
}

export async function resolveLegalEntityIdentityForBranch(
  tx: Prisma.TransactionClient,
  tenantId: string,
  branchId: string,
): Promise<LegalEntityIdentity | null> {
  const entity = await findEntityForBranch(tx, tenantId, branchId);
  return entity ? toLegalEntityIdentity(tx, entity) : null;
}

export interface LegalEntitySummary {
  id: string;
  legalName: string;
  registrationNumber: string | null;
  countryCode: string;
}

/**
 * Attribution summary for a batch of rows that each carry a `branchId` and an optional stamped
 * `legalEntityId` (payroll runs, generated reports): the stamped entity wins, else it is derived from the
 * branch (default entity as the last resort). One query for the stamped ids + one per DISTINCT unstamped
 * branch — never per row. Returns `null` for a row only when the tenant has no entity at all.
 */
export async function summarizeEntitiesForRows(
  tx: Prisma.TransactionClient,
  tenantId: string,
  rows: { id: string; branchId: string; legalEntityId: string | null }[],
): Promise<Map<string, LegalEntitySummary | null>> {
  const toSummary = (e: LegalEntity): LegalEntitySummary => ({
    id: e.id,
    legalName: e.legalName,
    registrationNumber: e.registrationNumber,
    countryCode: e.countryCode,
  });
  const stampedIds = [
    ...new Set(rows.map((r) => r.legalEntityId).filter((v): v is string => Boolean(v))),
  ];
  const stamped = stampedIds.length
    ? await tx.legalEntity.findMany({ where: { id: { in: stampedIds } } })
    : [];
  const byId = new Map(stamped.map((e) => [e.id, e]));
  const byBranch = new Map<string, LegalEntity | null>();
  const out = new Map<string, LegalEntitySummary | null>();
  for (const row of rows) {
    const stampedEntity = row.legalEntityId ? byId.get(row.legalEntityId) : undefined;
    if (stampedEntity) {
      out.set(row.id, toSummary(stampedEntity));
      continue;
    }
    if (!byBranch.has(row.branchId)) {
      byBranch.set(row.branchId, await findEntityForBranch(tx, tenantId, row.branchId));
    }
    const derived = byBranch.get(row.branchId) ?? null;
    out.set(row.id, derived ? toSummary(derived) : null);
  }
  return out;
}
