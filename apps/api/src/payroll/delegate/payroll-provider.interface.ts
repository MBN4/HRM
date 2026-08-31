import type { Employee, Prisma } from '@hrm/db';
import type { ResolvedPayrollPack } from '../payroll-pack.util';

export const PAYROLL_PROVIDER_ADAPTER = Symbol('PAYROLL_PROVIDER_ADAPTER');

export interface PayrollProviderPeriod {
  periodYear: number;
  periodMonth: number;
}

export interface PayrollProviderResult {
  grossPay: number;
  netPay: number;
  employerCost: number;
  componentBreakdown: { key: string; label: string; type: string; amount: number }[];
}

/**
 * The DELEGATE-mode seam — the SAME "swap one DI binding, no caller
 * changes" pattern 0.4's `AUTH_PROVIDER` (SSO), 0.8's `NotificationProvider`s,
 * and 1.3's `BIOMETRIC_DEVICE_ADAPTER` already establish (see
 * docs/conventions/auth-rbac.md → SSO seam,
 * docs/conventions/attendance.md → The biometric device seam). A
 * `payrollMode: 'DELEGATE'` CountryPack routes EVERY employee in the run to
 * this interface instead of `PayrollEngineService` — the in-house engine is
 * never invoked at all for such a run. `StubPayrollProviderAdapter` (bound
 * today) is a dev/reference implementation only; a real external-payroll-
 * provider integration (ADP, a local in-country processor, ...) implements
 * this interface and changes only the DI binding in `payroll.module.ts` —
 * no other code in this module changes. Such a real integration will
 * likely need its own async submit/poll/webhook contract rather than this
 * synchronous shape; a documented decision for that future step, not this
 * one (the same "documented, not silently accepted" posture the biometric
 * seam's own doc comment already takes for its own future real
 * integration).
 */
export interface PayrollProviderAdapter {
  submitEmployee(
    tx: Prisma.TransactionClient,
    tenantId: string,
    employee: Employee,
    pack: ResolvedPayrollPack,
    period: PayrollProviderPeriod,
  ): Promise<PayrollProviderResult>;
}
