# WAF — rule catalog and the edge/app rate-limit split

[← Back to edge overview](../README.md) · [Back to CLAUDE.md](../../../CLAUDE.md)

Two provider examples, the SAME logical policy, config-as-code:
[`cloudflare-waf-ruleset.tf`](./cloudflare-waf-ruleset.tf) (Terraform,
`cloudflare` provider) and [`aws-waf-webacl.json`](./aws-waf-webacl.json)
(an `AWS::WAFv2::WebACL` rules body). **Neither has been applied against a
real account** — see the top-of-file comment in each and
[`../README.md`](../README.md)'s verified-locally-vs-at-deploy table.

## Rule catalog

| #   | Rule                              | Blocks                                                                              | Cloudflare                                                   | AWS WAFv2                                                                                                                                                         |
| --- | --------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Managed OWASP-style ruleset       | SQLi, XSS, generic exploit payloads                                                 | Cloudflare Managed Ruleset (`http_request_firewall_managed`) | `AWSManagedRulesCommonRuleSet` + `AWSManagedRulesSQLiRuleSet`                                                                                                     |
| 2   | Known-bad-inputs / path traversal | `../`-shaped and other known-bad-input payloads                                     | Custom rule (`http.request.uri.path contains "../"`, etc.)   | `AWSManagedRulesKnownBadInputsRuleSet`                                                                                                                            |
| 3   | Bad-bot / scanner blocking        | `sqlmap`/`nikto`/`nmap`/`masscan`/`nessus`/`acunetix` User-Agents, empty User-Agent | Custom rule, `http.user_agent contains ...`                  | Custom `ByteMatchStatement`/`SizeConstraintStatement` (AWS's own Bot Control managed group is a real, separately-billed alternative — not assumed purchased here) |
| 4   | Request-size limit                | Bodies over 10MB                                                                    | Custom rule, `http.request.body.size gt 10485760`            | `SizeConstraintStatement`, `Size: 10485760`                                                                                                                       |
| 5   | Rate-based rule (volumetric)      | A single source IP flooding raw request volume                                      | `http_ratelimit` phase ruleset, 2000 req/5min/IP             | `RateBasedStatement`, `Limit: 2000`, `AggregateKeyType: IP`                                                                                                       |

**Rule 4's number is not arbitrary** — it matches
[`deploy/k8s/base/ingress.yaml`](../../k8s/base/ingress.yaml)'s own
`nginx.ingress.kubernetes.io/proxy-body-size: '10m'` annotation AND
`careers.controller.ts`'s `MAX_RESUME_SIZE_BYTES` (10MB, the careers
resume-upload limit). The edge limit must be **equal to or larger than**
the origin's own accepted size, never smaller — an edge cap tighter than
the app's own already-correct limit would reject a legitimate resume
upload before it ever reaches the app at all.

**Rollout posture**: both files' managed-ruleset rules are wired in
LOG-only mode (`Count`/an override with `enabled: true` but no
block-action switch) for the first deploy window, not `Block` from day
one — the same "prove it against real traffic before it can reject real
traffic" caution this codebase already applies elsewhere (e.g.
[security-hardening.md](../../../docs/conventions/security-hardening.md)'s
own `pnpm audit --audit-level=high` staying `continue-on-error: true`
until triaged). A managed ruleset's generic XSS/SQLi signatures can
false-positive against genuinely free-text fields this app accepts
(a candidate's cover letter via the careers apply route, an expense
claim's free-text description) — review a real sample of matched-but-
not-blocked requests before flipping to enforce.

## Edge vs. app rate limiting — how the two layers interact, not duplicate

This codebase already has a real, tested, per-tenant rate limiter
(`TenantRateLimitService`, step 0.10 — see
[resilience.md](../../../docs/conventions/resilience.md)). The edge rule
above (#5) is a **different, complementary** control, not a second copy
of the same thing:

|                       | Edge (WAF rate-based rule)                                                                                                                  | App (`TenantRateLimitService`)                                                                                                                                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Keyed by              | Source IP                                                                                                                                   | Resolved tenant (+ edition)                                                                                                                                                                                                          |
| Threshold             | Coarse, generous (2000/5min) — can't distinguish tenants                                                                                    | Precise, edition-tiered (`DEFAULT_RATE_LIMITS`: 200/500/2000 per minute for STARTER/PROFESSIONAL/ENTERPRISE), or a per-tenant admin override                                                                                         |
| Defends against       | Raw volumetric abuse from ONE source — including requests that never even resolve to a tenant at all (a scanner probing random paths/hosts) | A misbehaving or compromised TENANT consuming disproportionate shared capacity — a business/fairness concern the edge structurally cannot see, since tenant identity is only known once the request reaches `TenantScopeInterceptor` |
| Sees tenant identity? | Never — the edge only ever sees a Host header, an IP, and raw bytes; it runs before ANY of this app's own auth/tenant-resolution code       | Always — this is its entire job                                                                                                                                                                                                      |
| Response on trip      | The edge provider's own block/challenge page — never reaches the app                                                                        | A real `429` with `Retry-After` (`RateLimitExceptionFilter`, already tested)                                                                                                                                                         |

**Concretely, why both matter and neither substitutes for the other**:

- A shared office NAT with many legitimate users on one public IP should
  never trip the edge's coarse per-IP threshold under normal use — but
  should still be subject to their tenant's OWN quota once their combined
  usage crosses it. The edge doesn't know or care about that; the app
  does.
- A botnet spreading a flood across thousands of distinct source IPs
  (each individually well under the edge's per-IP threshold) sails
  straight past rule #5 — but the app's per-TENANT limiter still catches
  it if that traffic is all hammering one tenant's own routes, since it
  counts by resolved tenant identity, not source IP.
- The two never produce conflicting responses: a request the edge blocks
  never reaches the app at all (the app's own 429 is only ever seen for
  traffic that made it past the edge first) — no double-counting, no
  race, no shared state between the two layers.

This is the same "no single layer trusted alone" defense-in-depth posture
CLAUDE.md § 2 already states as a non-negotiable, applied here to rate
limiting specifically: the edge stops what it CAN see (raw volume per
source), the app stops what only it CAN see (per-tenant fairness).

## Verified locally vs. at deploy

See [`../README.md`](../README.md)'s consolidated table — in short: the
Terraform/JSON syntax was hand-written carefully against each provider's
documented schema (the JSON file's structural validity IS checked, via
`python3 -m json.tool`); neither was ever applied against a live
Cloudflare zone or AWS account (none exists in this environment), and
`terraform validate`/`terraform plan` were not run (no `terraform` binary
was available). A real deploy engineer should run both before applying.
