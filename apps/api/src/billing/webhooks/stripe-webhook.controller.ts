import { Controller, Headers, HttpCode, HttpStatus, Post, RawBodyRequest, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '../../tenancy/public.decorator';
import { StripeWebhookService } from './stripe-webhook.service';

/**
 * The ONE inbound-webhook endpoint in this codebase (step 4.2) — Stripe
 * posts every subscription/invoice/payment-method change here. `@Public()`
 * — deliberately NOT `@PlatformRoute()`: Stripe cannot authenticate as a
 * platform admin, and there is no tenant subdomain/header for this request
 * to resolve either (Stripe doesn't know or care which of our tenants a
 * customer belongs to) — tenant resolution happens INSIDE
 * `StripeWebhookService` itself, by looking up the event's own Stripe
 * customer id, the same narrow "authenticate via the payload, not a
 * header" shape `ApiKeyAuthService.validate`/the biometric device endpoint
 * already establish for their own non-JWT callers. Authenticity here comes
 * from the HMAC signature (`Stripe-Signature`), verified against the raw
 * request bytes — see main.ts's `rawBody: true` and
 * docs/conventions/billing.md.
 */
@Controller('billing/webhooks')
export class StripeWebhookController {
  constructor(private readonly webhookService: StripeWebhookService) {}

  @Post('stripe')
  @Public()
  @HttpCode(HttpStatus.OK)
  async handleStripeWebhook(@Req() req: RawBodyRequest<Request>, @Headers('stripe-signature') signature?: string): Promise<{ received: true }> {
    const rawBody = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
    await this.webhookService.handleRawEvent(rawBody, signature);
    return { received: true };
  }
}
