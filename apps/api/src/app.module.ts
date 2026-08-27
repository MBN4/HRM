import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { I18nModule } from './common/i18n/i18n.module';
import { CountryPacksModule } from './country-packs/country-packs.module';
import { CustomFieldsModule } from './custom-fields/custom-fields.module';
import { LicensingModule } from './licensing/licensing.module';
import { NotificationsModule } from './notifications/notifications.module';
import { QueueModule } from './queue/queue.module';
import { RedisModule } from './redis/redis.module';
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
    TenancyModule,
    AuthModule,
    CountryPacksModule,
    LicensingModule,
    WorkflowModule,
    NotificationsModule,
    AuditModule,
    CustomFieldsModule,
    I18nModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
