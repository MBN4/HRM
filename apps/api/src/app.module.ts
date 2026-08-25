import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { CountryPacksModule } from './country-packs/country-packs.module';
import { LicensingModule } from './licensing/licensing.module';
import { RedisModule } from './redis/redis.module';
import { TenancyModule } from './tenancy/tenancy.module';
import { WorkflowModule } from './workflow/workflow.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    // wildcard: true is required for AuditEventsListener's `@OnEvent('auth.*')`.
    EventEmitterModule.forRoot({ wildcard: true }),
    RedisModule,
    TenancyModule,
    AuthModule,
    CountryPacksModule,
    LicensingModule,
    WorkflowModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
