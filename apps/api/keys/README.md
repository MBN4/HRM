# License signing keys

RS256 keypair used to sign and verify lifetime/on-prem license files (see
docs/conventions/licensing-feature-flags.md → Two delivery modes →
Lifetime mode).

- `license-public-dev.pem` — **committed.** The public key ships in every
  build, SaaS and on-prem alike: it is all `LicenseVerificationService`
  needs to verify a license file's signature, and verification must work
  everywhere a license might be activated.
- `license-private-dev.pem` — **gitignored** (`.gitignore`'s
  `apps/api/keys/*private*.pem` rule). This is the local-dev stand-in for
  the vendor's real signing key. It is used ONLY by the issuing side
  (`LicenseSigningService`, wired into the platform-context "issue license"
  endpoint) and must never be present in an on-prem distribution artifact —
  an on-prem customer can verify a license but must never be able to mint
  one. This is an operational/packaging discipline as much as a code one:
  keep the real private key on vendor-controlled signing infrastructure
  only, and never include it in whatever gets shipped to a customer's
  environment.

Regenerate the dev pair locally with:

```
node -e "
const { generateKeyPairSync } = require('crypto');
const fs = require('fs');
const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
fs.writeFileSync('license-private-dev.pem', privateKey);
fs.writeFileSync('license-public-dev.pem', publicKey);
"
```

A real production keypair must be generated on vendor-controlled
infrastructure, not with this dev script, and the private key managed as a
secret outside source control (same rule this repo already applies to the
`hrm_app` DB password and JWT secrets).
