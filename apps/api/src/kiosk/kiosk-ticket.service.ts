import { createHmac, timingSafeEqual } from 'node:crypto';
import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { KIOSK_ERROR, TICKET_TTL_SECONDS } from './kiosk.constants';

export interface KioskTicketClaims {
  /** tenant, kiosk, employee this ticket vouches for */
  t: string;
  k: string;
  e: string;
  /** how the employee was identified */
  m: 'PIN' | 'BIOMETRIC';
  /** expiry, epoch seconds */
  x: number;
}

/**
 * A short-lived, stateless proof that THIS kiosk device just verified THIS employee (PIN or biometric).
 * It lets the screen show "Hello, Sam — Clock in / Clock out" between identify and the actual punch
 * without re-sending the PIN, and without a server-side session table.
 *
 * Bound to the tenant + kiosk + employee + an expiry, HMAC-SHA256-signed with a key DERIVED from
 * `JWT_SECRET` under a distinct label — so it can never be confused with (or substituted for) an access
 * token. It is NOT a credential on its own: it is only accepted on a `@KioskRoute()` call that also
 * carries the same kiosk's device token, and `KioskPunchService` re-checks the employee's status and
 * branch when it is redeemed.
 */
@Injectable()
export class KioskTicketService {
  private readonly key: Buffer;

  constructor(config: ConfigService) {
    const secret = config.get<string>('JWT_SECRET');
    if (!secret) {
      throw new Error('JWT_SECRET is required to sign kiosk tickets.');
    }
    this.key = createHmac('sha256', secret).update('hrm:kiosk-ticket:v1').digest();
  }

  sign(claims: Omit<KioskTicketClaims, 'x'>): { ticket: string; expiresInSeconds: number } {
    const full: KioskTicketClaims = {
      ...claims,
      x: Math.floor(Date.now() / 1000) + TICKET_TTL_SECONDS,
    };
    const body = Buffer.from(JSON.stringify(full)).toString('base64url');
    return { ticket: `${body}.${this.mac(body)}`, expiresInSeconds: TICKET_TTL_SECONDS };
  }

  /** The single "expired / forged / minted elsewhere" response — deliberately indistinguishable. */
  invalidTicket(): BadRequestException {
    return new BadRequestException({
      statusCode: 400,
      error: 'Bad Request',
      code: KIOSK_ERROR.TICKET_INVALID,
      message: 'This kiosk session has expired. Please start again.',
    });
  }

  verify(ticket: string): KioskTicketClaims {
    const invalid = () => this.invalidTicket();
    const [body, signature] = ticket.split('.');
    if (!body || !signature) {
      throw invalid();
    }
    const expected = Buffer.from(this.mac(body));
    const given = Buffer.from(signature);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
      throw invalid();
    }
    let claims: KioskTicketClaims;
    try {
      claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as KioskTicketClaims;
    } catch {
      throw invalid();
    }
    if (typeof claims.x !== 'number' || claims.x < Math.floor(Date.now() / 1000)) {
      throw invalid();
    }
    return claims;
  }

  private mac(body: string): string {
    return createHmac('sha256', this.key).update(body).digest('base64url');
  }
}
