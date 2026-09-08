import { Injectable } from '@nestjs/common';
import type { Prisma } from '@hrm/db';
import type { StatutoryComponent } from '@hrm/shared';
import { resolvePayrollPackConfig } from '../payroll/payroll-pack.util';

/**
 * Read-only statutory-scheme visibility — see docs/conventions/benefits.md.
 * THE BOUNDARY: this NEVER computes a payroll amount. Every
 * `statutory.components` entry on the resolved Country Pack (0.5) is
 * ALREADY applied automatically by the unmodified `PayrollEngineService`
 * on every real run (employee deduction / employer contribution alike) —
 * this service exists only to surface, for admin visibility, WHICH
 * statutory schemes apply to a given branch's country, reusing
 * `resolvePayrollPackConfig` (Payroll's own free function, imported
 * directly — no new resolution path). Legal correctness of a pack's
 * declared schemes is a per-country PACK-AUTHORING responsibility, the
 * SAME compliance boundary payroll.md documents for itself — this service
 * has no opinion on whether a scheme is named/rated correctly.
 */
@Injectable()
export class BenefitsStatutoryService {
  async listForBranch(tx: Prisma.TransactionClient, tenantId: string, branchId: string): Promise<{ countryCode: string; components: StatutoryComponent[] }> {
    const pack = await resolvePayrollPackConfig(tx, tenantId, branchId);
    return { countryCode: pack.countryCode, components: pack.config.statutory.components };
  }
}
