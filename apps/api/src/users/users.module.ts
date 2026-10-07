import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PasswordService } from '../auth/password.service';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

/**
 * Tenant user / team access management (step 7.1) — see
 * docs/conventions/user-management.md. `TenancyModule`/`AuditModule` are
 * `@Global()`; `AuthModule` is imported for `TokenService` (session
 * revocation — the same export Offboarding already uses). `PasswordService`
 * is stateless, so it's simply provided here again rather than widening
 * `AuthModule`'s exports (no change to auth core).
 */
@Module({
  imports: [AuthModule],
  controllers: [UsersController],
  providers: [UsersService, PasswordService],
})
export class UsersModule {}
