import { Module } from '@nestjs/common';
import { AccountingModule } from './adapters/accounting/accounting.module';
import { ApiKeysModule } from './api-keys/api-keys.module';
import { BiometricModule } from './biometric/biometric.module';
import { SlackModule } from './slack/slack.module';
import { V1Module } from './v1/v1.module';
import { WebhooksModule } from './webhooks/webhooks.module';

/**
 * Phase 3.3 — Integrations, the "extend without forking" escape hatch. See
 * docs/conventions/integrations.md for the full write-up. Six thin slices,
 * each its own sub-module:
 *   - `WebhooksModule` — outbound, signed, breaker-wrapped, queued webhook
 *     delivery over the domain events already emitted across the system.
 *   - `ApiKeysModule` — tenant-facing API key CRUD (the request-time
 *     AUTHENTICATION half lives in `apps/api/src/auth/api-key/`, imported
 *     by `TenancyModule` directly — see that module's own doc comment for
 *     why it's a separate module).
 *   - `V1Module` — the versioned public REST surface, API-key-authenticated.
 *   - `AccountingModule`/`SlackModule`/`BiometricModule` — the adapter seams
 *     (accounting export, Slack notifications, biometric device ingestion).
 * SSO itself lives in `AuthModule` (`auth/sso/`), not here — it EXTENDS the
 * 0.4 auth-provider abstraction directly, the same reasoning that keeps it
 * co-located with `AUTH_PROVIDER`/`LocalAuthProvider` rather than treated
 * as a generic "integration".
 */
@Module({
  imports: [WebhooksModule, ApiKeysModule, V1Module, AccountingModule, SlackModule, BiometricModule],
})
export class IntegrationsModule {}
