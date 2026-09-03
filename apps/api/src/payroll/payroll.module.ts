import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PAYROLL_RUN_QUEUE } from '../queue/queue.constants';
import { LicensingModule } from '../licensing/licensing.module';
import { WorkflowModule } from '../workflow/workflow.module';
import { PayrollController } from './payroll.controller';
import { PayrollComponentDefinitionService } from './components/payroll-component-definition.service';
import { PayrollEngineService } from './engine/payroll-engine.service';
import { PAYROLL_PROVIDER_ADAPTER } from './delegate/payroll-provider.interface';
import { StubPayrollProviderAdapter } from './delegate/stub-payroll-provider.adapter';
import { BANK_EXPORT_ADAPTER } from './bank-export/bank-export-adapter.interface';
import { BANK_EXPORT_ADAPTER_REGISTRY, BankExportAdapterRegistry } from './bank-export/bank-export-adapter.registry';
import { GenericCsvBankExportAdapter } from './bank-export/generic-csv-bank-export.adapter';
import { NachaStubBankExportAdapter } from './bank-export/nacha-stub-bank-export.adapter';
import { PayrollBankExportService } from './bank-export/payroll-bank-export.service';
import { PayslipPdfService } from './payslip/payslip-pdf.service';
import { PayslipService } from './payslip/payslip.service';
import { ExchangeRateService } from './runs/exchange-rate.service';
import { MultiCurrencyRollupService } from './runs/multi-currency-rollup.service';
import { PayrollRunQueueService } from './runs/payroll-run-queue.service';
import { PayrollRunProcessor } from './runs/payroll-run.processor';
import { PayrollRunService } from './runs/payroll-run.service';
import { PayrollWorkflowEventsListener } from './runs/payroll-workflow-events.listener';
import { GENERIC_CSV_BANK_EXPORT_FORMAT, NACHA_STUB_BANK_EXPORT_FORMAT } from './payroll.constants';

/**
 * The Payroll module (step 2.1, Phase 2's first step) — THE HIGHEST-RISK
 * MODULE in this codebase, see docs/conventions/payroll.md. Imports
 * `WorkflowModule` to inject `WorkflowEngineService` directly (a payroll
 * run's approval just starts a `WorkflowInstance` — THE RULE, see
 * docs/conventions/workflow.md), the SAME reuse `LeaveModule`/
 * `AttendanceModule` already establish. `LicensingModule` is imported for
 * `FeatureFlagGuard`'s own dependency (`FeatureFlagResolutionService`) —
 * every route in this controller is `@RequireFeature(MULTI_COUNTRY_PAYROLL)`-gated.
 * `EncryptionService`/
 * `StorageService`/`TenantContextService`/`IdempotencyService` need no
 * explicit import — all `@Global()`. `BullModule.registerQueue({name:
 * PAYROLL_RUN_QUEUE})` is the SAME reusable pattern every other Phase 1
 * queue-backed module already establishes. `PAYROLL_PROVIDER_ADAPTER`/
 * `BANK_EXPORT_ADAPTER` bind to their dev/reference implementations today
 * — the SAME "swap one DI binding, no caller changes" seam pattern 0.4/
 * 0.8/1.3 already establish.
 */
@Module({
  imports: [
    WorkflowModule,
    LicensingModule,
    BullModule.registerQueue({
      name: PAYROLL_RUN_QUEUE,
      defaultJobOptions: { attempts: 5, backoff: { type: 'exponential', delay: 1000 } },
    }),
  ],
  controllers: [PayrollController],
  providers: [
    PayrollComponentDefinitionService,
    PayrollEngineService,
    { provide: PAYROLL_PROVIDER_ADAPTER, useClass: StubPayrollProviderAdapter },
    { provide: BANK_EXPORT_ADAPTER, useClass: GenericCsvBankExportAdapter },
    // Step 3.3 — formalizes bank export as a genuinely PLUGGABLE registry,
    // additive on top of the BANK_EXPORT_ADAPTER binding above (unchanged,
    // still the default). See BankExportAdapterRegistry's own doc comment.
    GenericCsvBankExportAdapter,
    NachaStubBankExportAdapter,
    {
      provide: BANK_EXPORT_ADAPTER_REGISTRY,
      useFactory: (generic: GenericCsvBankExportAdapter, nachaStub: NachaStubBankExportAdapter) => {
        const registry = new BankExportAdapterRegistry();
        registry.register(GENERIC_CSV_BANK_EXPORT_FORMAT, generic);
        registry.register(NACHA_STUB_BANK_EXPORT_FORMAT, nachaStub);
        return registry;
      },
      inject: [GenericCsvBankExportAdapter, NachaStubBankExportAdapter],
    },
    PayrollBankExportService,
    PayslipPdfService,
    PayslipService,
    ExchangeRateService,
    MultiCurrencyRollupService,
    PayrollRunQueueService,
    PayrollRunProcessor,
    PayrollRunService,
    PayrollWorkflowEventsListener,
  ],
  // ExchangeRateService is additionally exported (step 3.1) so the
  // Expenses module can reuse the SAME Decimal/currency-rollup approach for
  // a claim's base-currency reporting snapshot — see
  // docs/conventions/operations-modules.md. PayrollRunProcessor itself
  // (already inside this module) is what performs the actual
  // reimbursement hand-off merge — see that file's own doc comment.
  exports: [PayrollRunService, ExchangeRateService],
})
export class PayrollModule {}
