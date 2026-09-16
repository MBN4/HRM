import { Injectable, NotImplementedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EncryptionKeyProvider, EncryptionKeySet } from './encryption-key-provider.interface';

/**
 * The REAL cloud-secrets-manager integration seam (AWS Secrets Manager /
 * HashiCorp Vault) — deliberately NOT implemented against a live service in
 * this step, the SAME documented-seam posture `AcmeCertProvider` already
 * takes for real ACME issuance (see that file's own doc comment): this
 * sandboxed dev/CI environment has no reachable AWS account or Vault
 * cluster to integrate against, and faking one would just be a second,
 * untested code path pretending to be real.
 *
 * A real implementation would fetch the current + previous field-encryption
 * key material from `SECRETS_MANAGER_SECRET_ID` (AWS) or a Vault KV path,
 * using whichever SDK/credentials the deployment already provisions (IAM
 * role, Vault AppRole, etc. — never a static credential baked into this
 * repo), and return the same `EncryptionKeySet` shape `EnvSecretsProvider`
 * does today. Swapping `ENCRYPTION_KEY_PROVIDER`'s binding in
 * `encryption.module.ts` from `EnvSecretsProvider` to this class (bound
 * only when `SECRETS_PROVIDER=aws-secrets-manager`/`vault`, never set in
 * this repo) is the entire integration point — `EncryptionService` needs no
 * change either way, the same "swap one DI binding, no caller changes" seam
 * `AUTH_PROVIDER`/`STRIPE_CLIENT`/`CERT_PROVIDER` already establish.
 */
@Injectable()
export class CloudSecretsProvider implements EncryptionKeyProvider {
  constructor(private readonly config: ConfigService) {}

  getKeys(): EncryptionKeySet {
    const provider = this.config.get<string>('SECRETS_PROVIDER');
    throw new NotImplementedException(
      `Real cloud secrets-manager integration ("${provider}") is a documented seam, not implemented in this environment. See apps/api/src/common/encryption/key-provider/cloud-secrets.provider.ts.`,
    );
  }
}
