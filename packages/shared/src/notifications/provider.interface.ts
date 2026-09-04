/**
 * The channel-provider seam — see /CLAUDE.md § Conventions → Notifications
 * → Provider seams. A plain, framework-agnostic contract (no NestJS
 * import) so it can live in `packages/shared`; `apps/api` binds one
 * concrete implementation per channel behind a DI token
 * (`EMAIL_PROVIDER`/`SMS_PROVIDER`/`PUSH_PROVIDER`), the same
 * bind-an-interface-to-a-token seam 0.4's `AUTH_PROVIDER` already
 * established for SSO. `IN_APP` has no provider of its own — persisting
 * the `NotificationDelivery` row IS the in-app delivery, there is no
 * external system to call.
 */
export interface NotificationProviderSendParams {
  recipientUserId: string;
  /** Channel-specific destination — an email address for EMAIL, a phone number for SMS, a device token for PUSH. */
  to: string;
  /** Only meaningful for channels that have one (EMAIL). */
  subject?: string;
  body: string;
  /** BCP-47 language tag the body was rendered in, for providers that want it (e.g. an ESP's own locale metadata). */
  locale: string;
  /** Step 4.3 (white-label) — the resolved tenant's branded sender identity for EMAIL, resolved via BrandingResolutionService. Undefined for every other channel. */
  fromName?: string;
  /** Step 4.3 — the resolved tenant's branded sender address for EMAIL, when it has set one. Undefined otherwise (a real ESP integration falls back to its own configured default address — see white-label.md's documented gap on sender-domain verification). */
  fromAddress?: string;
}

export interface NotificationProvider {
  send(params: NotificationProviderSendParams): Promise<void>;
}
