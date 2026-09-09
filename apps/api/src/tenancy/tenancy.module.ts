import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ApiKeyAuthModule } from '../auth/api-key/api-key-auth.module';
import { PermissionsCacheService } from '../auth/permissions-cache.service';
import { PermissionFieldDemoController } from '../common/permissions/demo/permission-field-demo.controller';
import { PermissionSerializerInterceptor } from '../common/permissions/permission-serializer.interceptor';
import { PlatformAuthContextModule } from '../platform/auth/platform-auth-context.module';
import { PlatformController } from '../platform/platform.controller';
import { OrgStructureCacheService } from './org-structure-cache.service';
import { ReplicaReadService } from './replica-read.service';
import { TenancyController } from './tenancy.controller';
import { TenantContextService } from './tenant-context.service';
import { TenantResolutionService } from './tenant-resolution.service';
import { TenantScopeInterceptor } from './tenant-scope.interceptor';

/**
 * Global so `TenantContextService` (and the `@CurrentTenant()` decorator,
 * which reads the same underlying store) are usable from any module without
 * re-importing this one. `TenantScopeInterceptor` is registered as a global
 * `APP_INTERCEPTOR`, so every route goes through tenant resolution unless
 * explicitly marked `@Public()` or `@PlatformRoute()`, and through JWT auth
 * unless also marked `@AllowAnonymous()`.
 *
 * Registers its own `JwtModule` (verification only, here) rather than
 * importing `AuthModule` (signing) — `AuthModule` registers the same
 * `JwtModule` config independently for that. Both read the same
 * `JWT_SECRET`/`JWT_EXPIRES_IN`, so a token either module verifies is
 * accepted by the other; duplicating the ~5-line registration avoids a
 * cross-module dependency for no real benefit.
 */
@Global()
@Module({
  imports: [
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_SECRET'),
        // `expiresIn` is typed against `ms`'s branded string literals, which
        // an env-sourced string can never satisfy statically; validity
        // (e.g. "15m") is enforced by `ms` itself at runtime instead.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        signOptions: { expiresIn: (config.get<string>('JWT_EXPIRES_IN') ?? '15m') as any },
      }),
    }),
    // Step 3.3 — the API-key authentication branch below needs
    // ApiKeyAuthService/ApiKeyRateLimitService. A small leaf module (see its
    // own doc comment for why this is a DIFFERENT module from the
    // tenant-facing ApiKeysModule).
    ApiKeyAuthModule,
    // Step 4.1 — the platform-admin authentication branch below needs
    // PlatformAuthContextService. Same leaf-module split, same reasoning.
    PlatformAuthContextModule,
  ],
  controllers: [TenancyController, PlatformController, PermissionFieldDemoController],
  providers: [
    TenantContextService,
    TenantResolutionService,
    PermissionSerializerInterceptor,
    ReplicaReadService,
    OrgStructureCacheService,
    PermissionsCacheService,
    { provide: APP_INTERCEPTOR, useClass: TenantScopeInterceptor },
  ],
  exports: [
    TenantContextService,
    TenantResolutionService,
    ReplicaReadService,
    OrgStructureCacheService,
    PermissionsCacheService,
  ],
})
export class TenancyModule {}
