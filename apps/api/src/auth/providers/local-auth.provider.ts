import { Injectable } from '@nestjs/common';
import type { Prisma, User } from '@hrm/db';
import { PasswordService } from '../password.service';
import type { AuthProvider } from './auth-provider.interface';

/** Email + password via argon2id. The only `AuthProvider` implementation today — see the interface for the SSO seam this satisfies. */
@Injectable()
export class LocalAuthProvider implements AuthProvider {
  readonly type = 'local';

  constructor(private readonly password: PasswordService) {}

  async validate(tx: Prisma.TransactionClient, tenantId: string, email: string, password: string): Promise<User | null> {
    const user = await tx.user.findUnique({ where: { tenantId_email: { tenantId, email } } });
    if (!user) {
      return null;
    }
    const valid = await this.password.verify(user.hashedPassword, password);
    return valid ? user : null;
  }
}
