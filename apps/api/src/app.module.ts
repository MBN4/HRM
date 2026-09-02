import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AnalyticsModule } from './analytics/analytics.module';
import { AttendanceModule } from './attendance/attendance.module';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { I18nModule } from './common/i18n/i18n.module';
import { EncryptionModule } from './common/encryption/encryption.module';
import { CountryPacksModule } from './country-packs/country-packs.module';
import { CustomFieldsModule } from './custom-fields/custom-fields.module';
import { EmployeesModule } from './employees/employees.module';
import { LeaveModule } from './leave/leave.module';
import { LicensingModule } from './licensing/licensing.module';
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
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
