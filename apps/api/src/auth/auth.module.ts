import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { LicensingModule } from '../licensing/licensing.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { PermissionsGuard } from './guards/permissions.guard';
import { TenantMfaService } from './mfa/tenant-mfa.service';
import { PasswordService } from './password.service';
import { AUTH_PROVIDER } from './providers/auth-provider.token';
import { LocalAuthProvider } from './providers/local-auth.provider';
import { OidcAuthProvider } from './sso/oidc-auth.provider';
import { SamlAuthProvider } from './sso/saml-auth.provider';
import { OIDC_AUTH_PROVIDER, SAML_AUTH_PROVIDER } from './sso/sso-auth-provider.interface';
import { SsoController } from './sso/sso.controller';
import { SsoService } from './sso/sso.service';
import { TokenService } from './token.service';

@Module({
  imports: [
    // Same config as tenancy.module.ts's registration (signing here,
    // verification there) — see that file for why this isn't shared via a
    // single cross-module registration.
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_SECRET'),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        signOptions: { expiresIn: (config.get<string>('JWT_EXPIRES_IN') ?? '15m') as any },
      }),
    }),
    // Step 3.3 — for FeatureFlagGuard's own dependency
    // (FeatureFlagResolutionService): SsoController's mutating/login routes
    // are @RequireFeature(FEATURE_FLAGS.SSO)-gated, the same reason
    // payroll.module.ts imports this.
    LicensingModule,
  ],
  controllers: [AuthController, SsoController],
  providers: [
    AuthService,
    PasswordService,
    TokenService,
    PermissionsGuard,
    TenantMfaService,
    LocalAuthProvider,
    // The SSO seam: AuthService depends on the AUTH_PROVIDER token, not on
    // LocalAuthProvider directly. Swapping in a tenant-configurable
    // SAML/OIDC provider later means changing this binding, not AuthService.
    { provide: AUTH_PROVIDER, useExisting: LocalAuthProvider },
    // Step 3.3 — FINISHES the SSO seam with a SEPARATE flow/DI-token pair,
    // not a second AUTH_PROVIDER binding (see
    // sso/sso-auth-provider.interface.ts's doc comment for why). The
    // AUTH_PROVIDER binding above is completely unchanged by this.
    SsoService,
    OidcAuthProvider,
    SamlAuthProvider,
    { provide: OIDC_AUTH_PROVIDER, useExisting: OidcAuthProvider },
    { provide: SAML_AUTH_PROVIDER, useExisting: SamlAuthProvider },
  ],
  // `TokenService` exported (step 2.3) for Offboarding's access-revocation
  // handoff (`TokenService.revokeAllForUser`) — see
  // docs/conventions/recruitment-lifecycle.md. Nothing else in this module
  // needs to be importable elsewhere yet.
  exports: [TokenService],
})
export class AuthModule {}
