import { Injectable } from '@nestjs/common';
import type { Prisma } from '@hrm/db';
import { formatInTimeZone } from '@hrm/shared';

/**
 * Thin API-layer wrapper around `@hrm/shared`'s `formatInTimeZone` — see
 * /CLAUDE.md § Conventions → i18n / timezone / RTL. Every timestamp is
 * stored/transmitted in UTC (Prisma `DateTime`, ISO strings); this is the
 * service other modules should call to render one for a specific user's
 * or branch's timezone rather than hand-rolling `Date` math.
 */
@Injectable()
export class TimezoneService {
  /** `Branch.timezone` (an IANA zone, set since 0.2) for the given branch, or null if it doesn't exist in the caller's tenant. */
  async resolveBranchTimezone(tx: Prisma.TransactionClient, branchId: string): Promise<string | null> {
    const branch = await tx.branch.findUnique({ where: { id: branchId }, select: { timezone: true } });
    return branch?.timezone ?? null;
  }

  format(instant: Date | string, timeZone: string, locale?: string): string {
    return formatInTimeZone(instant, timeZone, { locale });
  }
}
