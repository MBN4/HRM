# Edge security — WAF / DDoS / CDN (Phase 6.3)

[← Back to CLAUDE.md](../../CLAUDE.md) · [Build log](../../docs/BUILD_LOG.md) ·
[Convention doc](../../docs/conventions/edge-security.md)

This directory holds **configuration-as-code and operational runbooks**
for the edge infrastructure layer — a WAF, DDoS mitigation, and a CDN —
that lives IN FRONT of `deploy/k8s/`'s own ingress at a real hosting
provider (Cloudflare, AWS, or an equivalent). **None of it is applied
anywhere**: this sandboxed development environment has no internet-facing
deployment, no Cloudflare/AWS account, and no domain a real edge provider
could actually front. Per this step's own brief, that is stated
explicitly here and in every file below, never glossed over or implied as
tested. What IS real and locally verified is everything on the
**application side** that a genuine edge deployment depends on being
correct — client-IP resolution, cache-control correctness, and the app's
own graceful degradation under load — each backed by a real, executed
`apps/api` e2e test.

## Layout

| Path               | Covers                                                                                                                                                                                                                                                   |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`waf/`](./waf/)   | WAF rule catalog (OWASP-style managed rules, bad-bot blocking, request-size limits, a coarse IP-based rate-based rule) as Terraform (Cloudflare) + JSON (AWS WAFv2) — provider-portable, same logical policy. The edge-vs-app rate-limiting interaction. |
| [`ddos/`](./ddos/) | The DDoS mitigation posture (edge = first line for volumetric abuse, the app's 0.10 resilience chassis = second line) and an operational runbook.                                                                                                        |
| [`cdn/`](./cdn/)   | CDN cache configuration (respect-origin-Cache-Control as the one rule that matters most), CDN + data-residency, and CDN + white-label custom-domain/TLS.                                                                                                 |

## Security headers at the edge — the responsibility split

`configureSecurity()` (`apps/api/src/security/configure-security.ts`,
step 6.2) already sets real secure headers via `helmet` — HSTS,
`X-Content-Type-Options: nosniff`, `X-Frame-Options`, a tuned CSP — on
every response, from the ORIGIN. Placing a CDN/WAF in front changes
nothing about who is responsible for WHAT:

- **The origin (this app) remains the source of truth for every
  application-aware header** — CSP in particular, since it names this
  app's own script/style/connect sources (including the `/v1/docs`
  Swagger UI's documented `'unsafe-inline'` carve-out) and only this app
  knows what those actually are. **The edge must be configured to PASS
  THESE THROUGH UNMODIFIED** — never strip, never overwrite. Both
  Cloudflare and CloudFront default to forwarding origin response headers
  unless a Transform Rule / Response Headers Policy explicitly says
  otherwise; this step's own edge config-as-code (`waf/`, `cdn/`) adds NO
  such override anywhere, which is itself the correct, deliberate
  configuration — silence here means "pass through," not "forgotten."
- **HSTS may ADDITIONALLY be centralized at the edge** (e.g. Cloudflare's
  own "Always Use HTTPS" + a zone-level HSTS setting) as a real,
  optional, defense-in-depth duplication — never a REPLACEMENT for the
  origin's own `Strict-Transport-Security` header, since an on-prem/
  lifetime deployment with no CDN in front (see
  [white-label.md](../../docs/conventions/white-label.md) § 3's own
  "DNS-only, no CDN" topology) still needs the origin's own HSTS header
  to matter at all.
- **TLS termination**: unchanged from 5.3/4.3's own existing, honest
  framing — this Node process itself always speaks plain HTTP; TLS is
  terminated at whichever layer sits in front of it (the k8s ingress
  alone, or the CDN AND the k8s ingress in a CDN-fronted custom-domain
  topology — see [`cdn/README.md`](./cdn/README.md) § 3). `hsts` is still
  set by `configureSecurity()` regardless, since it's a response header
  instruction to the BROWSER, not a listener option this process itself
  acts on.
- **No header this app sends should ever be DUPLICATED with a
  conflicting value by the edge** — e.g. a WAF/CDN that adds its OWN
  `X-Frame-Options` on top of the origin's would be redundant at best,
  contradictory at worst if the two ever disagreed. This step's own
  config-as-code deliberately adds none of these — the edge's job here is
  network/request-shape filtering (WAF) and caching (CDN), not
  re-implementing this app's own, already-correct header policy.

## Client IP through the edge — the one genuinely testable piece

A real edge/WAF/CDN sits in front of `deploy/k8s/`'s own nginx ingress —
which ITSELF already adds one proxy hop, setting `X-Forwarded-For` when
forwarding to a pod. `apps/api/src/security/trusted-proxy.ts`
(`TRUSTED_PROXY_HOPS`, see that file's own doc comment and
[`docs/conventions/edge-security.md`](../../docs/conventions/edge-security.md))
makes `req.ip` — the ONLY thing this codebase reads for a client address
(`AuditInterceptor`'s captured `ip`, `esignature`'s signer IP capture) —
resolve the REAL client correctly once this many hops are declared, and
REFUSE to be spoofed when they aren't. This is the one piece of "does the
app read the real client IP through the edge correctly" that a sandboxed
environment CAN prove without a live edge deployment, and it is: see
`apps/api/test/edge-client-ip-trusted.e2e-spec.ts` (a declared trusted hop
correctly resolves a forwarded IP) and
`edge-client-ip-untrusted.e2e-spec.ts` (the default — no hop declared —
refuses to trust the identical header), both real, executed HTTP tests.

## Verified locally vs. at deploy — the consolidated table

| Claim                                                                                                                                   | Verified how                                                                                                                                                                         |
| --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Client IP resolves correctly through a declared trusted-proxy hop                                                                       | **Locally** — `edge-client-ip-trusted.e2e-spec.ts`, real HTTP, real audit-log assertion                                                                                              |
| A caller cannot spoof its own IP with no trusted hop declared                                                                           | **Locally** — `edge-client-ip-untrusted.e2e-spec.ts`                                                                                                                                 |
| Public/cacheable routes carry a real `public` Cache-Control; sensitive/authed/tenant routes are `no-store` (incl. on an error response) | **Locally** — `edge-cache-control.e2e-spec.ts`, 4 real HTTP assertions                                                                                                               |
| The app degrades gracefully under a real concurrent flood (critical protected, non-critical shed, clean recovery)                       | **Locally** — `edge-ddos-flood.e2e-spec.ts`, real concurrency, no mocking                                                                                                            |
| WAF/CDN config files are syntactically well-formed                                                                                      | **Partially locally** — the JSON file validated with `python3 -m json.tool`; the Terraform files were NOT run through `terraform validate` (no binary available in this environment) |
| A WAF rule actually blocks a real malicious request at a real edge                                                                      | **At deploy only** — no Cloudflare/AWS account exists here                                                                                                                           |
| A real DDoS is actually absorbed by a real edge provider                                                                                | **At deploy only** — see [`ddos/RUNBOOK.md`](./ddos/RUNBOOK.md)                                                                                                                      |
| A CDN actually respects (or ignores) the origin's `Cache-Control` in practice                                                           | **At deploy only** — see [`cdn/README.md`](./cdn/README.md)                                                                                                                          |
| Regional CDN routing / data-localization actually confines cached content to one jurisdiction                                           | **At deploy only** — a real, qualified-legal-review VERIFY item for Pakistan specifically, see [`cdn/README.md`](./cdn/README.md) § 2                                                |
| A CDN-fronted custom domain's edge TLS actually issues/renews                                                                           | **At deploy only** — extends 4.3's own already-honest `AcmeCertProvider` gap                                                                                                         |

Every "at deploy only" row above is a genuine hosting-layer dependency
this codebase cannot fabricate a working instance of locally — stated
here exactly as plainly as
[deployment-scaling.md](../../docs/conventions/deployment-scaling.md) and
[observability-load.md](../../docs/conventions/observability-load.md)
already state their own equivalent boundaries, never blurred with what
was actually run.
