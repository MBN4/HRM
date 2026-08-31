import { Injectable } from '@nestjs/common';
import type { Employee, Prisma } from '@hrm/db';
import { EncryptionService } from '../../common/encryption/encryption.service';
import type { ResolvedPayrollPack } from '../payroll-pack.util';
import type { PayrollProviderAdapter, PayrollProviderPeriod, PayrollProviderResult } from './payroll-provider.interface';

/**
 * The dev/reference DELEGATE-mode implementation — bound by default in
 * `payroll.module.ts`. No real external-payroll-provider protocol exists
 * yet (no vendor SDK, no webhook contract), the SAME "no real device
 * protocol yet" honesty `ManualBiometricDeviceAdapter`'s own doc comment
 * already states for itself. It deliberately does the SIMPLEST possible
 * thing that still proves the seam: gross = net = the employee's own
 * contractual basic salary (no tax/statutory computation at all — that is
 * the whole point of DELEGATE mode, an external provider owns all of
 * that), tagged so tests can assert this path — not
 * `PayrollEngineService` — is what ran.
 */
@Injectable()
export class StubPayrollProviderAdapter implements PayrollProviderAdapter {
  constructor(private readonly encryption: EncryptionService) {}

  async submitEmployee(
    _tx: Prisma.TransactionClient,
    _tenantId: string,
    employee: Employee,
    _pack: ResolvedPayrollPack,
    _period: PayrollProviderPeriod,
  ): Promise<PayrollProviderResult> {
    const basicSalary = employee.baseSalaryEncrypted ? Number(this.encryption.decrypt(employee.baseSalaryEncrypted)) : 0;

    return {
      grossPay: basicSalary,
      netPay: basicSalary,
      employerCost: basicSalary,
      componentBreakdown: [{ key: 'basic', label: 'Basic Salary (delegated)', type: 'EARNING', amount: basicSalary }],
    };
  }
}
