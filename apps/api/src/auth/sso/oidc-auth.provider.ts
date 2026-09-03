import { createPublicKey, type JsonWebKey } from 'node:crypto';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import type { OidcSsoConfigInput, SsoConfigInput } from '@hrm/shared';
import type { SsoAuthProvider, SsoIdentity } from './sso-auth-provider.interface';

interface Jwk {
  kty: string;
  kid?: string;
  n?: string;
  e?: string;
  [key: string]: unknown;
}

/**
 * The ONE real, cryptographically-verified `SsoAuthProvider` in this step —
 * see `saml-auth.provider.ts`'s doc comment for why SAML is a documented
 * gap instead. A standard Authorization Code flow: redirect to the IdP's
 * `authorizationEndpoint`, exchange the returned `code` at `tokenEndpoint`,
 * verify the `id_token`'s RS256 signature against the IdP's own published
 * JWKS (`jwksUri`) — using ONLY Node's built-in `crypto.createPublicKey`
 * (which imports a JWK directly, no extra dependency needed) plus
 * `jsonwebtoken` (already a transitive dependency of `@nestjs/jwt`, added
 * here as a direct one since this is the first place this codebase verifies
 * an EXTERNALLY-issued JWT rather than one it signed itself).
 */
@Injectable()
export class OidcAuthProvider implements SsoAuthProvider {
  readonly protocol = 'OIDC' as const;

  buildAuthorizationUrl(config: SsoConfigInput, callbackUrl: string, state: string): string {
    const oidc = this.asOidc(config);
    const url = new URL(oidc.authorizationEndpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', oidc.clientId);
    url.searchParams.set('redirect_uri', callbackUrl);
    url.searchParams.set('scope', oidc.scopes.join(' '));
    url.searchParams.set('state', state);
    return url.toString();
  }

  async handleCallback(config: SsoConfigInput, callbackUrl: string, params: Record<string, string>): Promise<SsoIdentity> {
    const oidc = this.asOidc(config);
    const code = params.code;
    if (!code) {
      throw new UnauthorizedException('The IdP did not return an authorization code.');
    }

    const tokenResponse = await fetch(oidc.tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: callbackUrl,
        client_id: oidc.clientId,
        client_secret: oidc.clientSecret,
      }).toString(),
    });
    if (!tokenResponse.ok) {
      throw new UnauthorizedException(`The IdP rejected the authorization code exchange (HTTP ${tokenResponse.status}).`);
    }
    const tokenBody = (await tokenResponse.json()) as { id_token?: string };
    if (!tokenBody.id_token) {
      throw new UnauthorizedException('The IdP token response did not include an id_token.');
    }

    const claims = await this.verifyIdToken(tokenBody.id_token, oidc);
    const email = typeof claims.email === 'string' ? claims.email : undefined;
    if (!email) {
      throw new UnauthorizedException('The id_token has no email claim.');
    }
    return {
      email,
      externalId: String(claims.sub),
      displayName: typeof claims.name === 'string' ? claims.name : undefined,
    };
  }

  private async verifyIdToken(idToken: string, config: OidcSsoConfigInput): Promise<jwt.JwtPayload> {
    const decodedHeader = jwt.decode(idToken, { complete: true })?.header;
    if (!decodedHeader) {
      throw new UnauthorizedException('The id_token is malformed.');
    }

    const jwksResponse = await fetch(config.jwksUri);
    if (!jwksResponse.ok) {
      throw new UnauthorizedException('Unable to fetch the IdP JWKS document.');
    }
    const { keys } = (await jwksResponse.json()) as { keys: Jwk[] };
    const matchingJwk = keys.find((key) => !decodedHeader.kid || key.kid === decodedHeader.kid);
    if (!matchingJwk) {
      throw new UnauthorizedException('No JWKS key matches the id_token.');
    }

    // Node's crypto imports a JWK directly (no extra library needed) —
    // exactly the standard mechanism JSON.stringify's own `.toJSON()`
    // protocol mirrors elsewhere in this codebase (see
    // @hrm/shared's redactSensitiveFields): use the platform's own
    // understanding of the format rather than reimplementing RSA key
    // construction from `n`/`e` by hand.
    const publicKey = createPublicKey({ key: matchingJwk as JsonWebKey, format: 'jwk' });

    try {
      return jwt.verify(idToken, publicKey, {
        algorithms: ['RS256'],
        issuer: config.issuer,
        audience: config.clientId,
      }) as jwt.JwtPayload;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new UnauthorizedException(`id_token verification failed: ${message}`);
    }
  }

  private asOidc(config: SsoConfigInput): OidcSsoConfigInput {
    if (config.protocol !== 'OIDC') {
      throw new UnauthorizedException('This tenant is not configured for OIDC.');
    }
    return config;
  }
}
