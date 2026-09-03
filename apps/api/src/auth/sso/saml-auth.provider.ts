import { randomUUID } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { Injectable, NotImplementedException } from '@nestjs/common';
import type { SamlSsoConfigInput, SsoConfigInput } from '@hrm/shared';
import type { SsoAuthProvider, SsoIdentity } from './sso-auth-provider.interface';

/**
 * HONEST LIMITATION, documented loudly (see docs/conventions/integrations.md
 * and `packages/shared/src/integrations/sso.validator.ts`'s own doc
 * comment): this builds a real SP-initiated SAML AuthnRequest (redirect
 * binding — deflate, base64, URL-encode, exactly per the SAML 2.0 HTTP-
 * Redirect binding spec) but does NOT verify the IdP's signed response.
 * XML signature verification (canonicalization, defending against
 * signature-wrapping attacks) is real, non-trivial cryptographic surface
 * area this step deliberately does not hand-roll without a certified
 * library — `OidcAuthProvider` is the ONE real, cryptographically-verified
 * SSO path in this step; SAML is a formalized SEAM (interface + DI token +
 * a real request-building half) with its trust-critical half stubbed,
 * exactly like every other Phase 3.3 adapter category (accounting/Slack-
 * config/bank-export) ships one real reference + documented gaps rather
 * than a full vendor build. `handleCallback` throws loudly rather than
 * silently trusting an unverified assertion — never enable SAML in
 * production against this implementation.
 */
@Injectable()
export class SamlAuthProvider implements SsoAuthProvider {
  readonly protocol = 'SAML' as const;

  buildAuthorizationUrl(config: SsoConfigInput, callbackUrl: string, state: string): string {
    const saml = this.asSaml(config);
    const requestId = `_${randomUUID()}`;
    const issueInstant = new Date().toISOString();
    const authnRequestXml =
      `<samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ` +
      `ID="${requestId}" Version="2.0" IssueInstant="${issueInstant}" ` +
      `Destination="${saml.idpSsoUrl}" AssertionConsumerServiceURL="${callbackUrl}" ` +
      `ProtocolBinding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST">` +
      `<saml:Issuer xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">${saml.spEntityId}</saml:Issuer>` +
      `</samlp:AuthnRequest>`;

    const encoded = deflateRawSync(Buffer.from(authnRequestXml, 'utf8')).toString('base64');
    const url = new URL(saml.idpSsoUrl);
    url.searchParams.set('SAMLRequest', encoded);
    url.searchParams.set('RelayState', state);
    return url.toString();
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async handleCallback(config: SsoConfigInput, callbackUrl: string, params: Record<string, string>): Promise<SsoIdentity> {
    throw new NotImplementedException(
      'SAML response verification is not implemented in this reference build — a certified XML-DSig verifier ' +
        '(canonicalization + signature-wrapping-attack resistance) is required before enabling SAML in production. ' +
        'Configure OIDC instead, or see docs/conventions/integrations.md for what a real implementation needs.',
    );
  }

  private asSaml(config: SsoConfigInput): SamlSsoConfigInput {
    if (config.protocol !== 'SAML') {
      throw new NotImplementedException('This tenant is not configured for SAML.');
    }
    return config;
  }
}
