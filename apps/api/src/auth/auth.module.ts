import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { PermissionsGuard } from './guards/permissions.guard';
import { PasswordService } from './password.service';
import { AUTH_PROVIDER } from './providers/auth-provider.token';
import { LocalAuthProvider } from './providers/local-auth.provider';
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
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    PasswordService,
    TokenService,
    PermissionsGuard,
    LocalAuthProvider,
    // The SSO seam: AuthService depends on the AUTH_PROVIDER token, not on
    // LocalAuthProvider directly. Swapping in a tenant-configurable
    // SAML/OIDC provider later means changing this binding, not AuthService.
    { provide: AUTH_PROVIDER, useExisting: LocalAuthProvider },
  ],
})
export class AuthModule {}
