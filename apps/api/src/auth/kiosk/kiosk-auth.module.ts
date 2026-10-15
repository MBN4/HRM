import { Module } from '@nestjs/common';
import { KioskAuthService } from './kiosk-auth.service';

/** A leaf module (HashingService is `@Global()`), imported by `TenancyModule` — the same split `ApiKeyAuthModule` documents. */
@Module({ providers: [KioskAuthService], exports: [KioskAuthService] })
export class KioskAuthModule {}
