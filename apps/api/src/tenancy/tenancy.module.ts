import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { PlatformController } from '../platform/platform.controller';
import { TenancyController } from './tenancy.controller';
import { TenantContextService } from './tenant-context.service';
import { TenantResolutionService } from './tenant-resolution.service';
import { TenantScopeInterceptor } from './tenant-scope.interceptor';

/**
 * Global so `TenantContextService` (and the `@CurrentTenant()` decorator,
 * which reads the same underlying store) are usable from any module without
 * re-importing this one. `TenantScopeInterceptor` is registered as a global
 * `APP_INTERCEPTOR`, so every route goes through tenant resolution unless
 * explicitly marked `@Public()` or `@PlatformRoute()`.
 */
@Global()
@Module({
  controllers: [TenancyController, PlatformController],
  providers: [
    TenantContextService,
    TenantResolutionService,
    { provide: APP_INTERCEPTOR, useClass: TenantScopeInterceptor },
  ],
  exports: [TenantContextService, TenantResolutionService],
})
export class TenancyModule {}
