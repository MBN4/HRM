import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MockStripeClient } from './mock-stripe.client';
import { RealStripeClient } from './real-stripe.client';
import { STRIPE_CLIENT } from './stripe-client.interface';

/**
 * Binds `STRIPE_CLIENT` — `RealStripeClient` whenever `STRIPE_SECRET_KEY`
 * is set (works against Stripe TEST or LIVE mode, whichever key it's
 * given — Stripe TEST mode is the real API, just `sk_test_...` keys, not a
 * separate SDK), `MockStripeClient` otherwise. This is exactly the
 * "no live Stripe account needed for the suite to run" seam this step's
 * own brief asks for — see docs/conventions/billing.md for how to plug
 * real keys in.
 */
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: STRIPE_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const secretKey = config.get<string>('STRIPE_SECRET_KEY');
        return secretKey ? new RealStripeClient(config) : new MockStripeClient();
      },
    },
  ],
  exports: [STRIPE_CLIENT],
})
export class StripeModule {}
