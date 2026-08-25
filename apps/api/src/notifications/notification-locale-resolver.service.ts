import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@hrm/db';
import { countryPackConfigSchema, isRtlLanguage, tenantCountryOverrideSchema } from '@hrm/shared';
import { mergeCountryPackConfig } from '../country-packs/country-pack-override.util';

export interface RecipientLocale {
  language: string;
  rtl: boolean;
}

/**
 * Resolves the LANGUAGE + RTL a notification should render in for one
 * recipient — see /CLAUDE.md § Conventions → Notifications → Recipient
 * locale resolution. `User.preferredLanguage` wins if set; otherwise
 * falls back to the Country Pack `locale` resolved for the recipient's
 * (first) branch, or the tenant's `defaultCountryCode` if the recipient
 * has no branch at all.
 *
 * Deliberately does NOT reuse `CountryPackResolutionService` — that
 * service reads `TenantContextService.getTx()`/`.tenantId` internally,
 * which only exist inside a request's `AsyncLocalStorage` context; this
 * runs from the notification worker, outside any request, with only an
 * explicit `tx` (see NotificationRecipientResolverService for the same
 * constraint). The two small queries below are duplicated rather than
 * touching `country-packs/` (out of scope for this step — see
 * /CLAUDE.md's 0.8 brief); the actual pack/override MERGE logic is
 * reused as-is via `mergeCountryPackConfig`, a plain function with no
 * request-context dependency, so the two-layer override model itself
 * never drifts between request-time resolution and this one.
 */
@Injectable()
export class NotificationLocaleResolverService {
  async resolveRecipientLocale(tx: Prisma.TransactionClient, tenantId: string, recipientUserId: string): Promise<RecipientLocale> {
    const user = await tx.user.findUniqueOrThrow({
      where: { id: recipientUserId },
      select: { preferredLanguage: true },
    });

    const countryCode = await this.resolveRecipientCountryCode(tx, tenantId, recipientUserId);
    const packRow = await tx.countryPack.findFirst({ where: { countryCode, isActive: true }, orderBy: { version: 'desc' } });
    if (!packRow) {
      throw new NotFoundException(`No active country pack is configured for country code "${countryCode}".`);
    }
    const pack = countryPackConfigSchema.parse(packRow.config);

    const overrideRow = await tx.tenantCountryOverride.findUnique({ where: { tenantId_countryCode: { tenantId, countryCode } } });
    const effective = overrideRow
      ? mergeCountryPackConfig(pack, tenantCountryOverrideSchema.parse(overrideRow.overrides))
      : pack;

    if (user.preferredLanguage) {
      return { language: user.preferredLanguage, rtl: isRtlLanguage(user.preferredLanguage) };
    }
    return { language: effective.locale.defaultLanguage, rtl: effective.locale.rtl };
  }

  private async resolveRecipientCountryCode(tx: Prisma.TransactionClient, tenantId: string, recipientUserId: string): Promise<string> {
    const userBranch = await tx.userBranch.findFirst({ where: { userId: recipientUserId }, select: { branchId: true } });
    if (userBranch) {
      const branch = await tx.branch.findUniqueOrThrow({ where: { id: userBranch.branchId }, select: { countryCode: true } });
      return branch.countryCode;
    }
    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { defaultCountryCode: true } });
    return tenant.defaultCountryCode;
  }
}
