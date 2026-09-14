import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { STATUTORY_REPORT_QUEUE } from '../queue/queue.constants';
import { StatutoryReportController } from './statutory-report.controller';
import { StatutoryReportService } from './statutory-report.service';
import { StatutoryReportQueueService } from './statutory-report-queue.service';
import { StatutoryReportProcessor } from './statutory-report.processor';
import { StatutoryReportPdfService } from './statutory-report-pdf.service';
import { StatutoryReportCsvService } from './statutory-report-csv.service';
import { STATUTORY_REPORT_GENERATOR_REGISTRY, StatutoryReportGeneratorRegistry } from './statutory-report-generator.interface';
import { PkIncomeTaxWithholdingGenerator } from './generators/pk-income-tax-withholding.generator';
import { PkEobiContributionGenerator } from './generators/pk-eobi-contribution.generator';
import { PkProvidentFundContributionGenerator } from './generators/pk-provident-fund-contribution.generator';
import { PkAnnualSalaryTaxStatementGenerator } from './generators/pk-annual-salary-tax-statement.generator';

/**
 * Statutory / government reporting (step 3.5.4, Phase 3.5's final slice) —
 * see docs/conventions/statutory-reporting.md. GENERATES periodic
 * government filing forms from already-FINALIZED `PayrollRun` data (2.1) —
 * distinct from CALCULATING the figures (the pack/engine's job, both
 * completely untouched by this module). `TenantContextService`/
 * `StorageService` need no explicit import — `@Global()`. Deliberately does
 * NOT import `PayrollModule`: this module calls Payroll's OWN free function
 * (`resolvePayrollPackConfig`) directly, the SAME "no module coupling
 * either direction" reuse `BenefitsStatutoryService` already establishes
 * for the identical need.
 *
 * COUNTRY-EXTENSIBILITY SEAM: `STATUTORY_REPORT_GENERATOR_REGISTRY` is a
 * plain code -> generator lookup, the SAME shape payroll's own
 * `BankExportAdapterRegistry` (step 3.3) already establishes. Adding a new
 * country's reports is (1) seeding new `StatutoryReportDefinition` rows in
 * `packages/db/src/seed-statutory-report-definitions.ts` and (2)
 * implementing + registering one generator per report code below — no
 * change to the controller/service/queue/processor/PDF/CSV framework any
 * of this module's OTHER files provide.
 */
@Module({
  imports: [
    BullModule.registerQueue({
      name: STATUTORY_REPORT_QUEUE,
      defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 1000 } },
    }),
  ],
  controllers: [StatutoryReportController],
  providers: [
    StatutoryReportService,
    StatutoryReportQueueService,
    StatutoryReportProcessor,
    StatutoryReportPdfService,
    StatutoryReportCsvService,
    PkIncomeTaxWithholdingGenerator,
    PkEobiContributionGenerator,
    PkProvidentFundContributionGenerator,
    PkAnnualSalaryTaxStatementGenerator,
    {
      provide: STATUTORY_REPORT_GENERATOR_REGISTRY,
      useFactory: (
        incomeTax: PkIncomeTaxWithholdingGenerator,
        eobi: PkEobiContributionGenerator,
        providentFund: PkProvidentFundContributionGenerator,
        annualStatement: PkAnnualSalaryTaxStatementGenerator,
      ) => {
        const registry = new StatutoryReportGeneratorRegistry();
        registry.register('PK_INCOME_TAX_WITHHOLDING', incomeTax);
        registry.register('PK_EOBI_CONTRIBUTION', eobi);
        registry.register('PK_PROVIDENT_FUND_CONTRIBUTION', providentFund);
        registry.register('PK_ANNUAL_SALARY_TAX_STATEMENT', annualStatement);
        return registry;
      },
      inject: [PkIncomeTaxWithholdingGenerator, PkEobiContributionGenerator, PkProvidentFundContributionGenerator, PkAnnualSalaryTaxStatementGenerator],
    },
  ],
})
export class StatutoryReportingModule {}
