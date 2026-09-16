# CDN — caching correctness, residency, and the custom-domain/TLS seam

[← Back to edge overview](../README.md) · [Back to CLAUDE.md](../../../CLAUDE.md)

## 1. What's cached, and the one rule that matters most

Config-as-code: [`cloudflare-cache-rules.tf`](./cloudflare-cache-rules.tf)
(not applied — see its own top-of-file note).

**The single most important CDN rule for this codebase is "respect the
origin's Cache-Control, never override it."** `apps/api` already sends
the correct value on every response — see
[`../../../apps/api/src/security/configure-security.ts`](../../../apps/api/src/security/configure-security.ts)'s
`defaultCacheControlMiddleware` (blanket `no-store` default, set before
ANY routing/auth even runs) and
[`cache-control.interceptor.ts`](../../../apps/api/src/security/cache-control.interceptor.ts)
(the explicit, reviewed `@CacheControlPublic(...)` opt-in used ONLY by
`CareersController`'s two public listing routes). The CDN's job is to
TRUST that, not second-guess it — `origin_cache_control = true` in the
Terraform above is the whole guarantee. **A caching mistake in the other
direction is a cross-tenant DATA LEAK**, not a staleness bug: a CDN that
force-caches based on path/status/content-type alone, ignoring an
explicit `no-store`, would serve tenant A's authenticated response to
tenant B's next visitor at the same shared edge PoP. This is why
`apps/api/test/edge-cache-control.e2e-spec.ts` exists as a real,
executed, `--runInBand` regression test on the APP side — the CDN
configuration above is the matching promise on the EDGE side, honestly
unverifiable here (no CDN account exists in this environment).

**What's actually cacheable today**: `GET /careers/postings` and
`GET /careers/postings/:slug` (60s edge TTL, 300s
stale-while-revalidate — see `CareersController`'s own doc comment for
the exact reasoning) — this codebase's only genuinely public, tenant-
resolved-but-visitor-independent content. `apps/portal`/`apps/admin`'s
own `_next/static/*` build assets get a separate, much longer (1-year)
override, since Next.js content-hashes those filenames — a filename only
ever changes when its content does, so the longest possible TTL is safe
by construction, not a caching risk. Everything else — every
authenticated route, every tenant-scoped read, `/branding/logo|favicon`
(already `private, max-age=300` — browser-cacheable, but `private` means
a SHARED/CDN cache must never store it, unchanged by this step) — is
`no-store` by the app's own default and the CDN never overrides that.

## 2. CDN + residency

Each region is already a fully separate, shared-nothing stack (5.3 — see
[deployment-scaling.md](../../../docs/conventions/deployment-scaling.md)
§ Regional deployment): its own Postgres, Redis, S3 bucket, and
`deploy/k8s/overlays/<region>/` manifest set. A real CDN's PoP network
already routes a visitor to whichever edge location is geographically
nearest by default — but the **origin** each PoP proxies to (on a cache
miss) must still be pinned to the CORRECT region's own stack, never
cross-region, or a PK tenant's cacheable content could be served via a US
origin. The concrete mechanism: one CDN "zone"/distribution PER region,
each pointed at that region's own `deploy/k8s/overlays/<region>/`
ingress hostname — mirroring the exact regional-stack-per-region model
5.3 already established, not a new topology invented here. For
Cloudflare this is a separate zone per region's own base domain
(`us.yourhrms.com`, `me.yourhrms.com` — see `configmap.yaml`'s own
per-region `TENANT_BASE_DOMAIN` patches); for AWS, a separate CloudFront
distribution per region pointed at that region's own ALB.

**A genuine data-localization requirement, not just a latency
preference**: for a jurisdiction where content must physically stay
in-region even at the CDN layer (not just "usually served from the
nearest PoP"), a real CDN's regional-restriction feature (e.g.
Cloudflare's Regional Services / Data Localization Suite, or restricting
a CloudFront distribution's edge locations) may be REQUIRED. Pakistan
(this codebase's first real client, pinned to `me-south-1` — see
[privacy-residency.md](../../../docs/conventions/privacy-residency.md))
is flagged here as the concrete case needing this decision, the SAME
explicit **VERIFY** discipline
[pakistan-pack.md](../../../docs/conventions/pakistan-pack.md) already
holds every legally-sensitive figure to — not resolved by this step
alone, since it depends on a specific regulatory reading (State Bank of
Pakistan / PECA considerations, already flagged in
`deploy/k8s/overlays/me-south-1/kustomization.yaml`) that needs a
qualified legal review before a production CDN configuration is chosen.

## 3. CDN + white-label custom domains + TLS — extending 4.3's seam

[white-label.md](../../../docs/conventions/white-label.md) § 3 already
built the real seam: `TenantDomain.verificationStatus`, DNS-TXT
ownership verification, and a `CERT_PROVIDER` DI token
(`MockCertProvider` bound today; `AcmeCertProvider` a documented
`NotImplementedException` seam — real ACME issuance needs a publicly
resolvable domain + a reachable challenge responder, neither exercisable
in this sandboxed environment). A CDN placed in front changes WHICH of
two honest topologies applies — both real, neither replacing the other:

- **CDN-fronted custom domain (the common SaaS shape)**: the tenant's
  verified custom domain's DNS CNAMEs to the CDN itself (Cloudflare's
  "custom hostname for SaaS providers" feature, or a CloudFront
  distribution with an ACM certificate for that hostname). The CDN
  terminates EDGE TLS for the custom domain using ITS OWN
  managed-certificate feature — `AcmeCertProvider`'s own documented gap
  becomes LARGELY MOOT for any tenant on this path, since the CDN's
  managed-cert feature is what actually issues/renews the certificate,
  not this app. The CDN then proxies to the origin (`deploy/k8s/`'s own
  ingress) over ITS OWN connection, which can itself be TLS ("Full
  (strict)" mode) using the k8s ingress's own cert-manager-issued
  certificate for the region's BASE hostname (`*.yourhrms.com` or
  `*.me.yourhrms.com`) — the custom domain's own certificate never needs
  to be re-issued at the k8s ingress layer at all under this topology.
- **DNS-only custom domain, no CDN** (an on-prem/lifetime-license
  deployment with no CDN account, or a SaaS tenant who opts out of
  proxying through the CDN): completely UNCHANGED from 4.3 — the k8s
  ingress + `CERT_PROVIDER`/ACME seam remains the real TLS story exactly
  as white-label.md already documents. This step adds an ALTERNATIVE
  topology for the SaaS-typical case, not a replacement for the
  on-prem-typical one.

Both topologies are honestly presented as "either/or depending on
deployment shape" — a real deployment picks one per-tenant (or a global
default with per-tenant exceptions), a decision this step deliberately
does not force, matching 4.3's own "the seam is real, the live CA
integration is not exercisable here" posture.

## Verified locally vs. at deploy

- **Verified locally**: the app's own Cache-Control correctness
  (`edge-cache-control.e2e-spec.ts`, real HTTP, actually run this step) —
  the half of this guarantee this codebase's own test suite CAN prove.
  The Terraform file's structural intent was hand-checked against the
  Cloudflare Cache Rules API's documented shape; no `terraform validate`
  was run (no binary available).
- **Verified at deploy only**: an actual CDN respecting (or not) the
  origin's `Cache-Control` in practice, a real cross-region CDN routing
  proof, a genuine custom-hostname TLS issuance at the CDN layer, and any
  regional-restriction feature actually confining a PoP's cached content
  to one jurisdiction — none of these are exercisable without a real
  CDN account and a real customer domain, neither of which exists in
  this environment.
