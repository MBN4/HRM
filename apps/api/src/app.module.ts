import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AnalyticsModule } from './analytics/analytics.module';
import { AttendanceModule } from './attendance/attendance.module';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { BillingModule } from './billing/billing.module';
import { BrandingModule } from './branding/branding.module';
import { I18nModule } from './common/i18n/i18n.module';
import { EncryptionModule } from './common/encryption/encryption.module';
import { HashingModule } from './common/hashing/hashing.module';
import { CountryPacksModule } from './country-packs/country-packs.module';
import { CustomFieldsModule } from './custom-fields/custom-fields.module';
import { EmployeesModule } from './employees/employees.module';
import { LeaveModule } from './leave/leave.module';
import { LicensingModule } from './licensing/licensing.module';
import { MigrationModule } from './migration/migration.module';
import { BenefitsModule } from './benefits/benefits.module';
import { EsignatureModule } from './esignature/esignature.module';
import { NotificationsModule } from './notifications/notifications.module';
import { PayrollModule } from './payroll/payroll.module';
import { PerformanceModule } from './performance/performance.module';
import { RecruitmentModule } from './recruitment/recruitment.module';
import { OnboardingModule } from './onboarding/onboarding.module';
import { OffboardingModule } from './offboarding/offboarding.module';
import { ExpensesModule } from './expenses/expenses.module';
import { AssetsModule } from './assets/assets.module';
import { HelpdeskModule } from './helpdesk/helpdesk.module';
import { AnnouncementsModule } from './announcements/announcements.module';
import { LmsModule } from './lms/lms.module';
import { LoggingModule } from './common/logging/logging.module';
import { MetricsModule } from './metrics/metrics.module';
import { IntegrationsModule } from './integrations/integrations.module';
import { PartitioningModule } from './partitioning/partitioning.module';
import { PrivacyModule } from './privacy/privacy.module';
import { PlatformModule } from './platform/platform.module';
import { StatutoryReportingModule } from './statutory-reporting/statutory-reporting.module';
import { QueueModule } from './queue/queue.module';
import { RedisModule } from './redis/redis.module';
import { ResilienceModule } from './resilience/resilience.module';
import { StorageModule } from './storage/storage.module';
import { TenancyModule } from './tenancy/tenancy.module';
import { WorkflowModule } from './workflow/workflow.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    // wildcard: true is required for DomainEventAuditListener's/
    // NotificationDispatchListener's `@OnEvent('auth.*')`-style patterns.
    EventEmitterModule.forRoot({ wildcard: true }),
    RedisModule,
    QueueModule,
    // Step 5.4 — structured logging (the ERROR_TRACKER seam) and the
    // shared Prometheus registry (`/metrics`, queue-depth polling). Both
    // @Global(), listed early alongside the rest of this cluster since
    // several resilience/cache services below now inject `MetricsService`
    // — see docs/conventions/observability-load.md.
    LoggingModule,
    MetricsModule,
    // Both @Global() — relative import order doesn't matter for DI
    // resolution (see ResilienceModule's doc comment for why load
    // shedding/the request timeout are plain services TenantScopeInterceptor
    // calls directly, rather than separately-ordered global interceptors).
    ResilienceModule,
    TenancyModule,
    AuthModule,
    CountryPacksModule,
    LicensingModule,
    WorkflowModule,
    NotificationsModule,
    AuditModule,
    CustomFieldsModule,
    I18nModule,
    EncryptionModule,
    HashingModule,
    StorageModule,
    EmployeesModule,
    LeaveModule,
    AttendanceModule,
    AnalyticsModule,
    PayrollModule,
    PerformanceModule,
    RecruitmentModule,
    OnboardingModule,
    OffboardingModule,
    ExpensesModule,
    AssetsModule,
    HelpdeskModule,
    AnnouncementsModule,
    LmsModule,
    // Step 3.3 (Integrations) — the last Phase 3 slice: outbound webhooks,
    // the versioned /v1 public API + API keys, adapter seams, biometric
    // device ingestion. See docs/conventions/integrations.md.
    IntegrationsModule,
    // Step 4.1 (Phase 4's first slice) — the vendor super-admin console's
    // backend: platform admin identity/MFA, tenant lifecycle, license/
    // country-pack admin, usage metrics, cross-tenant audit, impersonation.
    // See docs/conventions/vendor-console.md.
    PlatformModule,
    // Step 4.2 — SaaS billing/subscriptions via Stripe: the real
    // subscription-state producer FeatureFlagResolutionService's SaaS mode
    // has been reading from since 0.6, seat metering, invoices, payment
    // methods, and the vendor console's billing oversight (PlatformModule
    // imports this module for BillingService — see billing.module.ts).
    // See docs/conventions/billing.md.
    BillingModule,
    // Step 4.3 (Phase 4's final slice) — per-tenant white-label branding
    // (logo, palette, product name, favicon, login copy, email sender
    // identity, branded custom domains + a TLS-provisioning seam) and the
    // gated full-rebrand capability for lifetime/on-prem tenants. See
    // docs/conventions/white-label.md.
    BrandingModule,
    // Step 3.5.1 — the data migration & onboarding toolkit: column-mapped
    // CSV/XLSX import of a new client's existing org structure/employees/
    // leave opening balances, dry-run-then-commit, routed through the REAL
    // module services (EmployeeService, LeaveBalanceService, ...). See
    // docs/conventions/data-migration.md.
    MigrationModule,
    BenefitsModule,
    // Step 3.5.3 — e-signatures: a generic, polymorphic signature-request
    // model (internal + external token-scoped signers, sequential/parallel
    // via signer `order`), the tamper-evident evidentiary trail, and the
    // Offer/Policy integrations. See docs/conventions/e-signatures.md.
    EsignatureModule,
    // Step 5.2 (Phase 5) — table partitioning + archival: the automated
    // partition-creation job and the age-based archival-to-object-storage
    // job for attendance_records/audit_log/platform_audit_log (the actual
    // native PARTITION BY RANGE conversion lives in packages/db's
    // partition_high_growth_tables migration). See
    // docs/conventions/partitioning-archival.md.
    PartitioningModule,
    // Step 3.5.4 (Phase 3.5's final slice) — statutory/government reporting:
    // generates periodic government filing forms/exports FROM already-
    // FINALIZED PayrollRun data (2.1) via a country-extensible report
    // catalog + a pluggable per-report-code generator registry, Pakistan
    // being the first concrete country. See
    // docs/conventions/statutory-reporting.md.
    StatutoryReportingModule,
    // Step 6.1 (Phase 6's first slice) — data privacy & residency:
    // data-subject export/erasure (anonymize-within audit_log, never
    // row-deleted), consent tracking, the processing register + retention
    // policy engine (building on 5.2's TenantRetentionOverride seam), and
    // the residency-enforcement guard wired into TenantScopeInterceptor.
    // See docs/conventions/privacy-residency.md.
    PrivacyModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
