import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { CloudSecretsProvider } from './key-provider/cloud-secrets.provider';
import { ENCRYPTION_KEY_PROVIDER } from './key-provider/encryption-key-provider.interface';
import { EnvSecretsProvider } from './key-provider/env-secrets.provider';
import { EncryptionService } from './encryption.service';

/**
 * `@Global()`, same reasoning `AuditModule`/`TenancyModule` document for
 * themselves: `EncryptionService` is a general-purpose primitive (today
 * used by `EmployeeModule` for bank/salary fields, plus tenant/platform
 * MFA secrets) any future PII-adjacent module should reuse rather than
 * reimplementing its own encrypt-at-rest helper — see
 * docs/conventions/employee.md.
 *
 * Binds `ENCRYPTION_KEY_PROVIDER` — `EnvSecretsProvider` (reads
 * `FIELD_ENCRYPTION_KEY*` env vars) by default, `CloudSecretsProvider` (a
 * documented `NotImplementedException` seam) whenever `SECRETS_PROVIDER`
 * names a real cloud secrets manager — the SAME "useFactory branches on one
 * env var" shape `StripeModule` already establishes for `STRIPE_CLIENT`.
 */
@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    EnvSecretsProvider,
    CloudSecretsProvider,
    {
      provide: ENCRYPTION_KEY_PROVIDER,
      inject: [ConfigService, EnvSecretsProvider, CloudSecretsProvider],
      useFactory: (config: ConfigService, envProvider: EnvSecretsProvider, cloudProvider: CloudSecretsProvider) => {
        const secretsProvider = config.get<string>('SECRETS_PROVIDER') ?? 'env';
        return secretsProvider === 'env' ? envProvider : cloudProvider;
      },
    },
    EncryptionService,
  ],
  exports: [EncryptionService],
})
export class EncryptionModule {}
