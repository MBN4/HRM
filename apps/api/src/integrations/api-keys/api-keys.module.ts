import { Module } from '@nestjs/common';
import { LicensingModule } from '../../licensing/licensing.module';
import { ApiKeyController } from './api-key.controller';
import { ApiKeyService } from './api-key.service';

/** Tenant-facing CRUD (create/list/revoke) — distinct from `apps/api/src/auth/api-key`'s request-time authentication service. See that module's doc comment for why. */
@Module({
  imports: [LicensingModule],
  controllers: [ApiKeyController],
  providers: [ApiKeyService],
})
export class ApiKeysModule {}
