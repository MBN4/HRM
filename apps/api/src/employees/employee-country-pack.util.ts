import { NotFoundException } from '@nestjs/common';
import type { Prisma } from '@hrm/db';
import { countryPackConfigSchema, tenantCountryOverrideSchema } from '@hrm/shared';
import { mergeCountryPackConfig } from '../country-packs/country-pack-override.util';
import { CountryPackNotFoundError } from '../country-packs/country-pack-resolution.service';

/**
 * Resolves the effective `requiredEmployeeFields` for a branch — the same
 * branch -> countryCode -> pack -> tenant-override resolution
 * `CountryPackResolutionService` performs, DUPLICATED here with an explicit
 * `tx`/`tenantId` signature instead of depending on that service directly.
 *
 * This is necessary, not redundant: `CountryPackResolutionService` reads
 * `TenantContextService.getTx()`/`.tenantId` internally, which only exist
 * inside an HTTP request's `AsyncLocalStorage` context (populated by
 * `TenantScopeInterceptor`) — but `EmployeeService` must run this SAME
 * validation from BOTH an HTTP request (create/update) AND the bulk-import
 * BullMQ worker (no request context at all). This is the exact constraint
 * `NotificationLocaleResolverService` (0.8) and `WorkflowEscalationService`
 * (0.7) already document for themselves — see
 * docs/conventions/notifications-queues.md and docs/conventions/workflow.md
 * — solved the same way: duplicate the couple of small lookup queries with
 * an explicit-`tx` signature, while still reusing the actual MERGE logic
 * (`mergeCountryPackConfig`) as-is, since it's a plain function with no
 * request-context dependency and the two-layer override model must never
 * drift between request-time resolution and this one.
 */
export async function resolveRequiredEmployeeFields(
  tx: Prisma.TransactionClient,
  tenantId: string,
  branchId: string,
): Promise<string[]> {
  const branch = await tx.branch.findUnique({
    where: { id: branchId },
    select: { countryCode: true, tenantId: true },
  });
  if (!branch) {
    throw new NotFoundException(`Branch "${branchId}" was not found.`);
  }

  let countryCode = branch.countryCode;
  if (!countryCode) {
    const tenant = await tx.tenant.findUniqueOrThrow({
      where: { id: branch.tenantId },
      select: { defaultCountryCode: true },
    });
    countryCode = tenant.defaultCountryCode;
  }

  const packRow = await tx.countryPack.findFirst({
    where: { countryCode, isActive: true },
    orderBy: { version: 'desc' },
  });
  if (!packRow) {
    throw new CountryPackNotFoundError(countryCode);
  }
  const pack = countryPackConfigSchema.parse(packRow.config);

  const overrideRow = await tx.tenantCountryOverride.findUnique({
    where: { tenantId_countryCode: { tenantId, countryCode } },
  });
  if (!overrideRow) {
    return pack.requiredEmployeeFields;
  }

  const override = tenantCountryOverrideSchema.parse(overrideRow.overrides);
  return mergeCountryPackConfig(pack, override).requiredEmployeeFields;
}
