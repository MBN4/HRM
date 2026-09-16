# Edge security — WAF / DDoS / CDN

[← Back to CLAUDE.md](../../CLAUDE.md) · [Build log](../BUILD_LOG.md)

Defined in step 6.3 (Phase 6's third slice) — `apps/api/src/security`,
`apps/api/src/recruitment/careers`, `apps/api/test/edge-*.e2e-spec.ts`,
`deploy/edge/`. See [`docs/BUILD_LOG.md`](../BUILD_LOG.md) (the "6.3"
entry) for the full file list and verification notes. **This step's own
brief, stated up front and held to throughout**: edge infrastructure (a
WAF, DDoS mitigation, a CDN) lives at the HOSTING layer, in front of this
application, and genuinely CANNOT be fully run in this sandboxed
development environment — there is no internet-facing deployment, no
Cloudflare/AWS account, no real customer domain. What this step delivers
is real, provider-portable configuration-as-code, honest operational
documentation, and — the part that IS fully real and locally verified —
every piece of app-side behavior a genuine edge deployment depends on
being correct. Every claim below is explicitly marked verified-locally or
verified-at-deploy; see [`deploy/edge/README.md`](../../deploy/edge/README.md)'s
own consolidated table for the single-page version.

Builds on [security-hardening.md](./security-hardening.md) (the secure
headers/CORS this step's edge sits in front of, never duplicates or
weakens), [deployment-scaling.md](./deployment-scaling.md) (the
`deploy/k8s/` ingress topology the edge fronts), [resilience.md](./resilience.md)
(the 0.10 chassis — per-tenant rate limiting, load shedding, circuit
breakers — that remains the app's own, complementary, non-duplicated
control), [privacy-residency.md](./privacy-residency.md) (CDN caching
must respect the SAME region a tenant is pinned to), [white-label.md](./white-label.md)
(custom domains + the `CERT_PROVIDER` TLS seam this step's CDN topology
extends), [integrations.md](./integrations.md) (the public `/v1` API and
webhooks that also sit behind this same edge), and
[tenant-resolution.md](./tenant-resolution.md) (subdomain/custom-domain
resolution, unchanged, running BEHIND the edge exactly as it always has).

## 1. WAF — config-as-code + app readiness

### 1.1 Rule configuration, two providers, one logical policy

[`deploy/edge/waf/`](../../deploy/edge/waf/) ships the SAME rule catalog
for two providers — `cloudflare-waf-ruleset.tf` (Terraform, the
`cloudflare` provider's `cloudflare_ruleset` resource) and
`aws-waf-webacl.json` (an `AWS::WAFv2::WebACL` rules body) — proving
provider-portability rather than committing to one vendor: an OWASP-style
managed ruleset (SQLi/XSS/generic exploits — Cloudflare's Managed
Ruleset / AWS's `AWSManagedRulesCommonRuleSet`+`AWSManagedRulesSQLiRuleSet`),
known-bad-input/path-traversal coverage
(`AWSManagedRulesKnownBadInputsRuleSet` / a custom `../`-matching rule),
bad-bot/scanner-tool User-Agent blocking (`sqlmap`/`nikto`/`nmap`/
`masscan`/`nessus`/`acunetix`/empty UA), a request-size limit
(**10MB — deliberately matching, never smaller than,
`deploy/k8s/base/ingress.yaml`'s own `proxy-body-size: '10m'` AND
`CareersController`'s real `MAX_RESUME_SIZE_BYTES`**, cross-referenced
directly rather than an invented number), and a coarse, IP-based
rate-based rule (2000 req/5min/IP). See
[`deploy/edge/waf/README.md`](../../deploy/edge/waf/README.md) for the
full per-rule table and the rollout posture (managed rules run in
LOG-only mode for the first deploy window, matching this codebase's own
existing "prove it against real traffic before it can reject real
traffic" caution — see security-hardening.md § 1.9's own
`continue-on-error` `pnpm audit` precedent).

**Neither file has been applied anywhere** — no Cloudflare zone/AWS
account exists in this environment, and no `terraform` binary was
available to even run `terraform validate` against the `.tf` file. The
JSON file's structural validity IS checked (`python3 -m json.tool`); the
Terraform files were hand-written carefully against each provider's
documented resource schema and should be `terraform validate`d against a
real, pinned provider version before applying.

### 1.2 Edge vs. app rate limiting — how the two layers interact, never duplicate

**The core design point of this whole section.** The edge's rate-based
rule is keyed by source IP, coarse, and CANNOT see which tenant a request
belongs to (it runs before this app's own `TenantScopeInterceptor` ever
resolves one) — it exists to stop raw volumetric abuse from a single
source, including traffic that never even resolves to a tenant at all
(a scanner probing random hosts/paths). `TenantRateLimitService` (0.10,
unchanged by this step) remains the precise, tenant/edition-aware control
— a business/fairness concern the edge structurally cannot enforce. The
two never conflict (an edge-blocked request never reaches the app at all,
so there is no double-429/race) and neither substitutes for the other: a
shared-NAT office of legitimate users should never trip the edge's coarse
threshold but should still respect their tenant's own quota; a botnet
spread across thousands of distinct IPs sails under the edge's per-IP
threshold but still trips the app's per-tenant limiter if it's all
hammering one tenant. See
[`deploy/edge/waf/README.md`](../../deploy/edge/waf/README.md)'s own
table for the full side-by-side comparison.

### 1.3 App readiness — real client IP through the edge (LOCAL, tested)

`apps/api/src/security/trusted-proxy.ts` (`configureTrustedProxy`,
wired into `main.ts` right after app creation) is the ONE piece of "does
this app correctly read the real client through the edge" that a
sandboxed environment CAN fully prove, because it's about THIS app's own
behavior, not a live third-party service. `TRUSTED_PROXY_HOPS` (env,
default `0`/unset — **trust nothing**, the same "no setup needed for
local dev, never insecure by default" posture `DEPLOYMENT_REGION`/
`PLATFORM_MODE_ENABLED` already establish) sets Express's own `trust
proxy` hop count, consulted by every `req.ip` read in this codebase —
`AuditInterceptor`'s captured `ip` field (0.9) and `esignature`'s signer
IP capture (3.5.3) are the two real, existing consumers; there is no
per-IP rate limiter or geo-IP feature in this codebase today for this to
also feed (an honest scope note, not a gap silently left unaddressed —
§ 1.2 above is why per-tenant, not per-IP, is the correct app-side
rate-limiting granularity here).

**The real topology this hop-count models**: `deploy/k8s/base/ingress.yaml`'s
own nginx ingress ALREADY adds one proxy hop before a request reaches any
pod — `deploy/k8s/base/configmap.yaml` now ships `TRUSTED_PROXY_HOPS: '1'`
as its production default for exactly that hop alone. A deployment that
ALSO places a CDN/WAF (`deploy/edge/`) in front of that ingress must bump
this to `2` in its own overlay — **the count must match the deployment's
REAL proxy chain exactly; setting it higher than the actual hop count is
a real spoofing vector**, stated plainly in `trusted-proxy.ts`'s own doc
comment.

**Verified locally, both directions, real HTTP**:
`apps/api/test/edge-client-ip-trusted.e2e-spec.ts` (`TRUSTED_PROXY_HOPS=1`
declared — a forwarded `X-Forwarded-For: 203.0.113.5` resolves into the
real audit-log `ip` field exactly) and
`edge-client-ip-untrusted.e2e-spec.ts` (the default, unset — the
IDENTICAL spoofed header is IGNORED, the captured IP is never the
attacker-supplied value) — split into two files, the same "separate file
per differing top-level env config" discipline
`privacy-residency.e2e-spec.ts`/`licensing-lifetime.e2e-spec.ts` already
establish, since `TRUSTED_PROXY_HOPS` is baked into the Express app's own
`trust proxy` setting once at bootstrap, not re-read per request.

## 2. DDoS protection — documented posture + app resilience (LOCAL, tested)

**Two lines of defense, stated plainly, never one control trusted
alone** (CLAUDE.md § 2's own non-negotiable, applied here): the edge
(Cloudflare/AWS Shield) absorbs L3/L4 volumetric floods entirely outside
this Node application's own reach, plus generic high-volume L7 floods via
§ 1's own rate-based rule; the EXISTING 0.10 resilience chassis — load
shedding, circuit breakers, per-tenant rate limits, DB pool/backpressure
protection, the request timeout, none of it modified by this step — is
the real, already-built second line, for exactly the traffic shapes the
edge cannot fully catch on its own: a distributed flood spread thin
enough across source IPs to stay under the edge's coarse per-IP
threshold, an application-layer TARGETED attack against one expensive
route (not volumetric by source IP at all), or a genuine legitimate
traffic spike that isn't an attack but still needs graceful degradation
rather than a hard edge block. See
[`deploy/edge/ddos/RUNBOOK.md`](../../deploy/edge/ddos/RUNBOOK.md) for
the full posture write-up, the detection signals (all already real, from
5.4's own Prometheus alerts/Grafana panels — no new monitoring built
here), and a sequential operational runbook (including a real, already-
existing lever this step didn't need to build: the 0.10
`PATCH /platform/rate-limits/:tenantId` override, for the "surgical,
per-tenant, application-layer-targeted" case the edge's own IP-based
tools can't help with) that ends by naming Phase 6.4 (incident response +
chaos engineering, not yet built) as where a formal postmortem process
belongs.

**Verified locally, real HTTP concurrency, not deterministic
counter-driving**: `apps/api/test/edge-ddos-flood.e2e-spec.ts` fires a
genuine ~60-request concurrent burst at `/resilience/demo/low-priority`
(each held open long enough to force real overlap) simultaneously with
~15 concurrent `/resilience/demo/critical` requests — asserting SOME
low-priority requests are shed (503, proving the mechanism engaged),
SOME still succeed (proving it isn't an all-or-nothing collapse), EVERY
critical request succeeds throughout, and the system recovers cleanly
(an ordinary request plus both health checks succeed) the instant the
flood subsides. This is deliberately a DIFFERENT, complementary proof to
`resilience.e2e-spec.ts`'s own deterministic in-flight-counter-driven
load-shedding tests (documented there as more reliable for THEIR specific
ordering assertion) — this one is closer to what a real flood actually
looks like, at a scale a plain jest process can drive reliably with no
k6/Docker dependency.

## 3. CDN — config + correctness

### 3.1 Cache-control correctness — the anti-leak default (LOCAL, tested)

**The stakes, stated plainly, per this step's own brief**: a caching
mistake in the "too permissive" direction is a CROSS-TENANT DATA LEAK — a
shared/CDN cache serving tenant A's authenticated response to tenant B's
next visitor at the same edge PoP — not merely a staleness bug. The fix
is DEFAULT-DENY, not default-allow:

- **`defaultCacheControlMiddleware`** (`apps/api/src/security/configure-security.ts`)
  sets `Cache-Control: no-store` on EVERY response, as plain Express
  middleware running before tenant resolution, before any guard/
  interceptor, before a route is even matched — so it applies uniformly
  to every outcome (a 2xx, a 401 thrown by `TenantScopeInterceptor`
  itself, a 403 from a guard, a 500) with ZERO dependency on Nest
  interceptor-nesting order. This is a deliberate choice, not an
  oversight: this codebase's own `resilience.md` already documents that
  Nest does NOT reliably order `APP_INTERCEPTOR`s registered in different
  modules relative to each other — the exact hazard a naive "just add
  another global interceptor" cache-control implementation would have
  hit, sidestepped entirely by using middleware for the universal
  default instead.
- **`@CacheControlPublic(maxAgeSeconds, staleWhileRevalidateSeconds)`** +
  `@UseInterceptors(CacheControlInterceptor)` (`apps/api/src/security/
cache-control.{decorator,interceptor}.ts`) is the single, explicit,
  reviewed opt-IN a route author must reach for — deliberately
  ROUTE-SCOPED, not a second global interceptor, for the identical
  ordering-hazard reason above: Nest applies `@UseInterceptors()`
  deterministically around just that route's own handler, no cross-module
  ambiguity to get wrong. `CareersController`'s two public listing routes
  (`GET /careers/postings`, `GET /careers/postings/:slug`) are this
  codebase's first and, as of this step, only user — 60s edge TTL, a
  300s `stale-while-revalidate` window (a newly published/closed posting
  propagates within a minute; a visitor mid-window gets an instant cached
  response while the CDN revalidates in the background). A 404 from the
  SAME public route (an unknown slug) still gets the public cache header,
  not `no-store` — deliberately: this is a non-sensitive, PUBLIC response
  either way, and caching a "no such posting" 404 briefly is a real,
  common CDN optimization against repeated bad-slug probing, not a
  privacy concern.
- A handler that ALREADY sets its own `Cache-Control` (`BrandingController`'s
  pre-existing `private, max-age=300` on the logo/favicon streams, step
  4.3) is left completely untouched — `res.setHeader` always overwrites,
  never appends, and the middleware's own default only ever fires when no
  header exists yet.

**Verified locally, 4 real HTTP assertions**:
`apps/api/test/edge-cache-control.e2e-spec.ts` — the careers listing
carries the exact expected `public, max-age=60, s-maxage=60,
stale-while-revalidate=300`; the SAME route's own 404 carries the
identical public header; an authenticated, tenant-scoped read
(`GET /custom-fields/definitions/:entityType`) is `no-store`; and an
UNAUTHENTICATED request to that SAME protected route (a 401, thrown by
`TenantScopeInterceptor` before the route's own interceptor stack ever
runs) is ALSO `no-store` — proving the middleware-based default holds
even for a response Nest's routing never got far enough to reach a
route-scoped interceptor for.

### 3.2 CDN configuration-as-code

[`deploy/edge/cdn/cloudflare-cache-rules.tf`](../../deploy/edge/cdn/cloudflare-cache-rules.tf) —
the single most important rule is `origin_cache_control = true` (Cache
Rules, zone-wide default): **respect the origin's own `Cache-Control`,
never override it** — the exact edge-side promise matching § 3.1's
app-side guarantee. One deliberate, narrow override: a 1-year edge+
browser TTL for `apps/portal`/`apps/admin`'s own content-hashed
`_next/static/*` build assets (a DIFFERENT origin than `apps/api`,
per `deploy/k8s/base/ingress.yaml`'s own path split — never matched
against any `apps/api` response), safe because Next.js's own build only
ever changes such a filename when its content changes. Not applied
anywhere, same honest boundary as § 1.1.

### 3.3 CDN + residency

Each region is already a fully separate, shared-nothing stack (5.3) with
its own `deploy/k8s/overlays/<region>/` manifest set — a real CDN's own
PoP network routes by proximity, but the ORIGIN each PoP proxies to on a
cache miss must stay pinned to the correct region's own stack: one CDN
zone/distribution PER region, mirroring the existing regional-stack
model exactly, never a new topology. For a jurisdiction with a genuine
data-localization REQUIREMENT (not just a latency preference), a real
CDN's regional-restriction feature may be required — Pakistan
(`me-south-1`, this codebase's first real client) is named as the
concrete case, flagged as an explicit **VERIFY** item requiring a
qualified legal review, the SAME discipline
[pakistan-pack.md](./pakistan-pack.md) already holds every legally-
sensitive figure to. See
[`deploy/edge/cdn/README.md`](../../deploy/edge/cdn/README.md) § 2 for
the full write-up.

### 3.4 CDN + white-label custom domains + TLS

Extends 4.3's real `TenantDomain`/`CERT_PROVIDER` seam (see
[white-label.md](./white-label.md) § 3) with an HONEST second topology,
never a replacement for the first: a **CDN-fronted custom domain** (the
common SaaS shape) has the CDN itself terminate edge TLS for the tenant's
custom domain via its OWN managed-certificate feature — largely mooting
`AcmeCertProvider`'s own documented gap for any tenant on this path,
since the CDN's managed cert is what actually issues/renews it, not this
app — then proxies to the k8s ingress over its own TLS connection using
the REGION's base-domain certificate (unmodified, still cert-manager-
issued). A **DNS-only custom domain, no CDN** (on-prem/lifetime, or a
SaaS tenant opting out of the CDN) is completely UNCHANGED from 4.3 — the
k8s ingress + ACME seam remains the real story. See
[`deploy/edge/cdn/README.md`](../../deploy/edge/cdn/README.md) § 3.

## 4. Security headers at the edge — the responsibility split

`configureSecurity()` (6.2) remains the source of truth for every
application-aware header (CSP in particular — only this app knows its own
script/style/connect sources) — the edge must PASS THESE THROUGH
UNMODIFIED, never strip or overwrite; this step's own edge config-as-code
adds no header-transform rule anywhere, which is itself the correct,
deliberate configuration (silence here means "pass through," not
"forgotten"). HSTS may be ADDITIONALLY set at the edge as real,
optional defense-in-depth duplication (Cloudflare's own "Always Use
HTTPS" + zone HSTS) — never a replacement, since a DNS-only/no-CDN
deployment (§ 3.4) still needs the origin's own header to matter at all.
No header this app sends should ever be duplicated with a CONFLICTING
value by the edge; this step's config-as-code deliberately introduces
none. See [`deploy/edge/README.md`](../../deploy/edge/README.md)'s own §
on this for the full write-up.

## Scope discipline — what this step did NOT touch

`TenantRateLimitService`, `LoadSheddingService`, `CircuitBreakerService`,
`DbPoolExhaustionFilter`, and every other piece of the 0.10 resilience
chassis are completely UNMODIFIED — this step's app-side additions
(`trusted-proxy.ts`, `cache-control.{decorator,interceptor}.ts`,
`defaultCacheControlMiddleware`) are new, additive files/middleware, not
changes to existing resilience logic. `packages/db` gained no schema/
migration change. `TenantResolutionService`/`CorsOriginService` (0.3/6.2)
are unmodified — the edge sits in front of, and is transparent to, tenant
resolution exactly as designed. `CareersController`'s own business logic
(`CareersService`) is untouched — only two decorators/an interceptor were
added to its two existing GET routes.

## Verified

**Verified locally** (real HTTP, `apps/api`'s full suite green): 4 new
e2e files — `edge-client-ip-trusted.e2e-spec.ts` (1 test),
`edge-client-ip-untrusted.e2e-spec.ts` (1 test),
`edge-cache-control.e2e-spec.ts` (4 tests), `edge-ddos-flood.e2e-spec.ts`
(1 test) — **7 new tests, all passing**. Full `apps/api` suite: **72
suites, 685 tests**, all green except the SAME single pre-existing
`migration.e2e-spec.ts` timing flake this suite has carried since 5.1
(confirmed unrelated to this step — 10/10 clean on an isolated rerun,
exactly the same pattern every prior step since 5.1 has documented for
this one file). `@hrm/db` (37/37) and `@hrm/mobile` (19/19) unaffected.
Full-repo `pnpm build`/`pnpm lint` green across all 8 workspace tasks.
The one new JSON config file (`aws-waf-webacl.json`) validated as
well-formed JSON directly (`python3 -m json.tool`).

**Verified at deploy only, honestly, never implied as tested here**: any
WAF rule actually blocking a real malicious request; a real DDoS actually
being absorbed by a real edge provider; a real CDN actually respecting
(or ignoring) the origin's `Cache-Control` in practice; regional CDN
routing/data-localization actually confining cached content to one
jurisdiction; a CDN-fronted custom domain's edge TLS actually issuing/
renewing; `terraform validate`/`terraform plan` against either `.tf`
file (no `terraform` binary was available in this environment). See
[`deploy/edge/README.md`](../../deploy/edge/README.md)'s own consolidated
table for the single-page version of this split.
