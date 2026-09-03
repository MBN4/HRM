import { Global, Module } from '@nestjs/common';
import { HashingService } from './hashing.service';

/** `@Global()`, same reasoning as `EncryptionModule` — see `hashing.service.ts`. */
@Global()
@Module({
  providers: [HashingService],
  exports: [HashingService],
})
export class HashingModule {}
