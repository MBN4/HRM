# DDoS mitigation — posture, runbook, and the app-side second line

[← Back to edge overview](../README.md) · [Back to CLAUDE.md](../../../CLAUDE.md)

## The posture, stated plainly

**Two lines of defense, never one control trusted alone** (the same
non-negotiable CLAUDE.md § 2 already states for security generally):

1. **The edge (Cloudflare/AWS Shield) absorbs volumetric attacks** — L3/L4
   floods (SYN floods, UDP amplification, ...) are a hosting-layer concern
   entirely outside this Node application's own reach; a real edge
   provider's always-on network-layer scrubbing handles these before a
   single byte reaches `deploy/k8s/`'s own ingress. Generic, high-volume
   L7 floods are caught by the WAF's own rate-based rule (see
   [`../waf/README.md`](../waf/README.md)).
2. **The app's existing 0.10 resilience chassis is the SECOND line** — see
   [resilience.md](../../../docs/conventions/resilience.md) — for exactly
   the traffic shapes the edge structurally cannot fully catch:
   - A **moderate distributed flood** spread across enough source IPs that
     each individually stays under the edge's own coarse per-IP threshold
     (see the WAF README's own worked example).
   - An **application-layer TARGETED attack** against one specific
     expensive route (e.g. repeatedly hitting an authenticated, DB-heavy
     report/dashboard endpoint from a small number of legitimate-looking
     sessions) — this isn't volumetric by source IP at all, so a generic
     edge rate rule can't distinguish it from real traffic. This is
     exactly what load shedding + circuit breakers + DB pool protection
     exist for.
   - A **genuine legitimate traffic spike** (a real customer's own
     marketing campaign, a mass password-reset event) that isn't an
     attack at all but still needs graceful degradation — shed LOW-
     priority work, never a hard edge block, since blocking real customers
     is the wrong failure mode for this case.

**This step's own real, LOCAL, jest proof of the app-side half**: see
`apps/api/test/edge-ddos-flood.e2e-spec.ts` — a genuine concurrent burst
of ~60 in-flight requests against `/resilience/demo/low-priority`
overlapping ~15 concurrent `/resilience/demo/critical` requests: SOME
low-priority requests are shed (503), SOME still succeed (graceful, not
all-or-nothing), EVERY critical request succeeds throughout, and the
system recovers cleanly (ordinary requests + both health checks succeed)
the instant the flood subsides. This is a genuinely different, real-HTTP-
concurrency proof than `resilience.e2e-spec.ts`'s own deterministic
in-flight-counter-driven tests (documented there as more reliable for
THEIR specific ordering assertion) — complementary, not a replacement.

## Detection signals — already real, from 5.4

No new monitoring was built for this step — the exact signals a genuine
DDoS shows up in were already shipped in
[observability-load.md](../../../docs/conventions/observability-load.md):

- `hrm_load_shed_rejections_total` (by priority) spiking — the app is
  genuinely shedding load right now.
- `hrm_rate_limit_rejections_total` (by source: tenant/api-key/auth)
  spiking — either a genuine per-tenant abuse case, or (if spread across
  MANY tenants simultaneously) a signal worth cross-checking against the
  edge's own analytics.
- The existing Prometheus alert rules
  (`deploy/observability/prometheus/alerts.yml`) already cover 5xx rate,
  p99 latency, a rate-limit-rejection spike, and sustained load shedding —
  these fire FIRST, operationally, before anyone manually notices a
  problem.
- The edge provider's OWN security/analytics dashboard (Cloudflare
  Security Events / AWS WAF sampled requests + CloudWatch metrics for the
  Web ACL) — this is deploy-time-only visibility, not exercisable here.

## Runbook — sequential, operational

1. **Confirm the signal.** A Grafana alert fired (see above) or a
   support/ops report of degraded service. Check the API Overview
   dashboard's rate-limit/load-shed/5xx panels first.
2. **Check the edge provider's own dashboard** to see whether it's
   already absorbing the traffic (a real DDoS is usually visible there
   FIRST, before it ever reaches the app enough to trip the app's own
   alerts) — if the edge is already fully mitigating, no further action
   needed beyond monitoring.
3. **If traffic is still reaching the origin**, tighten the edge posture
   temporarily:
   - Cloudflare: enable "I'm Under Attack Mode" (adds a JS challenge to
     every visitor — a blunt, effective, temporary measure) via the
     dashboard or `cloudflare_zone_settings_override` (`security_level =
"under_attack"`).
   - Either provider: lower the WAF rate-based rule's own threshold
     temporarily — `var.waf_rate_limit_threshold` (Cloudflare Terraform)
     or the AWS WebACL's `RateBasedStatement.Limit` — a deliberate,
     time-boxed tightening, reverted once the incident is over (a
     permanently lower threshold risks false-positiving real customers).
4. **If the attack is APPLICATION-layer and TARGETED** (bypassing the
   edge's own volumetric detection entirely — a small number of sessions
   hammering one expensive, tenant-scoped route), the edge tools above
   won't help by themselves. Use the EXISTING, already-real, already-
   tested per-tenant rate-limit override lever from 0.10:
   `PATCH /platform/rate-limits/:tenantId` (see
   [resilience.md](../../../docs/conventions/resilience.md)) to tighten
   that ONE tenant's own quota immediately, without affecting any other
   tenant — this is a genuinely different, more surgical tool than the
   edge's own IP-based blunt instrument, and it already exists; this
   runbook is not asking for new code.
5. **Post-incident.** Capture the timeline (start/end, peak
   shed/rejection rate, which mitigation step resolved it) and feed it
   into a formal postmortem process — **this is explicitly where Phase
   6.4 (incident response + chaos engineering, not yet built — see
   CLAUDE.md § 6) is meant to plug in.** This runbook stops at "how to
   respond right now"; a structured postmortem template/process is 6.4's
   own job, not invented here.

## Verified locally vs. at deploy

- **Verified locally**: the app-side graceful-degradation proof above
  (`edge-ddos-flood.e2e-spec.ts`, real HTTP concurrency, actually run this
  step) — critical paths protected, non-critical shed, clean recovery,
  zero crash. The detection signals (Prometheus alert rules, Grafana
  panels) were already verified against real local instances in 5.4.
- **Verified at deploy only, honestly, not glossed over**: a real edge
  provider genuinely absorbing a real volumetric attack (no internet-
  facing deployment, no real Cloudflare/AWS account exists in this
  sandboxed environment); "Under Attack Mode"/a tightened rate-based rule
  actually engaging against real attack traffic; the runbook's own steps
  being exercised in a live incident. This is the SAME honest boundary
  [deployment-scaling.md](../../../docs/conventions/deployment-scaling.md)
  and
  [observability-load.md](../../../docs/conventions/observability-load.md)
  already draw for their own un-exercisable-here claims (a live HPA
  scale-event, a real Sentry capture) — stated plainly, not implied as
  already covered.
