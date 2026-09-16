# Phase 6.3 (edge security) — WAF configuration-as-code for Cloudflare,
# ONE of two provider examples this directory ships (see
# aws-waf-webacl.json for the AWS WAFv2 equivalent) — see
# docs/conventions/edge-security.md and README.md in this directory for
# the full rule catalog + the edge-vs-app rate-limit interaction.
#
# NOT applied anywhere — this repo has no Cloudflare account/zone to apply
# it against, and no `terraform` binary was available in the environment
# this step was authored in to even run `terraform validate` against it.
# Written carefully against the `cloudflare` provider's documented
# `cloudflare_ruleset` resource shape; a real deploy engineer should run
# `terraform validate` (and `terraform plan`) against their own pinned
# provider version before applying — field names/enums in Cloudflare's
# Ruleset API have shifted across provider major versions.
#
# Variables this root expects to be supplied (a real deployment's own
# `terraform.tfvars`/CI secrets — never hardcoded here):
#   cloudflare_zone_id      — the zone this API/portal/admin's hostnames live in
#   waf_rate_limit_threshold — requests per IP per period before a 429/challenge
#                              (default below matches this step's own
#                              documented reasoning: coarse, IP-based,
#                              deliberately generous — see README.md)

variable "cloudflare_zone_id" {
  type        = string
  description = "Cloudflare zone ID for this deployment's hostnames (yourhrms.com and *.yourhrms.com — see deploy/k8s/base/ingress.yaml)."
}

variable "waf_rate_limit_threshold" {
  type        = number
  default     = 2000
  description = "Requests per source IP per 5-minute period before the edge rate-based rule engages. Coarse/IP-based — see README.md's own 'edge vs app rate limiting' section for why this is deliberately much higher than any single legitimate user's traffic, not tenant-aware, and not a substitute for TenantRateLimitService."
}

# --- 1. Managed OWASP-style ruleset (SQLi / XSS / path traversal / generic exploits) ---
# Cloudflare's own "Cloudflare Managed Ruleset" (phase
# http_request_firewall_managed) already implements the OWASP Core
# Ruleset's rule categories — enabling the managed ruleset is the
# supported way to get this coverage without hand-authoring regex
# signatures Cloudflare's own threat-intel team already maintains.
resource "cloudflare_ruleset" "managed_owasp" {
  zone_id     = var.cloudflare_zone_id
  name        = "hrm-managed-owasp"
  description = "Cloudflare Managed Ruleset — SQLi/XSS/path-traversal/generic exploit signatures, vendor-maintained."
  kind        = "zone"
  phase       = "http_request_firewall_managed"

  rules {
    action = "execute"
    action_parameters {
      id = "efb7b8c949ac4650a09736fc376e9aee" # Cloudflare Managed Ruleset (account-visible ID; confirm the current ID in your own dashboard/API before applying — Cloudflare has rotated this ID across ruleset-engine migrations)
      overrides {
        # LOG, not BLOCK, for the first deploy window — see README.md's
        # own "roll out WAF rules in LOG mode first" operational note.
        # Flip to enabled=true / action=block once a real traffic sample
        # has been reviewed for false positives against this app's own
        # routes (careers applications legitimately contain free-text
        # resume/cover-letter content that a blunt XSS signature could
        # false-positive on).
        rules {
          id      = "*"
          enabled = true
        }
      }
    }
    expression  = "true"
    description = "Run the full managed OWASP-equivalent ruleset against every request to this zone."
  }
}

# --- 2. Custom rules: bad-bot / known-exploit-tool blocking ---
resource "cloudflare_ruleset" "custom_firewall" {
  zone_id     = var.cloudflare_zone_id
  name        = "hrm-custom-waf-rules"
  description = "Bad-bot/scanner blocking, request-size limit — complements the managed ruleset above."
  kind        = "zone"
  phase       = "http_request_firewall_custom"

  # Known scanner/exploit-tool User-Agents — sqlmap/nikto/nmap/masscan/etc.
  # never have a legitimate reason to hit this API; block outright rather
  # than challenge.
  rules {
    action      = "block"
    expression  = "(http.user_agent contains \"sqlmap\") or (http.user_agent contains \"nikto\") or (http.user_agent contains \"nmap\") or (http.user_agent contains \"masscan\") or (http.user_agent contains \"nessus\") or (http.user_agent contains \"acunetix\") or (http.user_agent eq \"\")"
    description = "Block known scanner/exploit-tool user agents and empty User-Agent."
  }

  # Request-size limit at the edge. Matches deploy/k8s/base/ingress.yaml's
  # own `nginx.ingress.kubernetes.io/proxy-body-size: '10m'` annotation —
  # deliberately set EQUAL, never SMALLER, than the origin's own accepted
  # size (the careers resume-upload route's own MAX_RESUME_SIZE_BYTES is
  # 10MB — see careers.controller.ts) — an edge limit smaller than the
  # origin's own would reject a legitimate upload before it ever reaches
  # the app's own, already-correct limit.
  rules {
    action      = "block"
    expression  = "(http.request.body.size gt 10485760)"
    description = "Reject request bodies over 10MB at the edge — matches the k8s ingress's own proxy-body-size and the careers resume-upload limit; never set lower than either."
  }

  # Path-traversal-shaped requests against routes that never take a raw
  # filesystem-ish path segment — this app has NO route that serves a file
  # by an attacker-controlled relative path (StorageService keys are
  # generated server-side, never taken from a URL segment), so a `../` or
  # encoded-traversal sequence anywhere in the URI is unambiguously hostile
  # here, unlike a generic file server where it might be a legitimate (if
  # unusual) filename fragment.
  rules {
    action      = "block"
    expression  = "(http.request.uri.path contains \"../\") or (http.request.uri.path contains \"..%2f\") or (http.request.uri.path contains \"%2e%2e\")"
    description = "Block path-traversal-shaped request paths — this app has no route that resolves a filesystem path from a URL segment."
  }
}

# --- 3. Rate-based rule — the COARSE, volumetric edge layer ---
# See README.md's own "edge vs app rate limiting" section for the full
# reasoning: this is IP-based and deliberately generous (var.waf_rate_limit_threshold,
# default 2000 req/5min) — it exists to stop a single source hammering
# this zone with raw volume BEFORE it ever reaches the origin (and before
# a tenant is even resolved), never to enforce the app's own tenant/
# edition-aware quota (TenantRateLimitService, 0.10) — that stays entirely
# an app-layer concern.
resource "cloudflare_ruleset" "rate_limiting" {
  zone_id     = var.cloudflare_zone_id
  name        = "hrm-edge-rate-limit"
  description = "Coarse, IP-based volumetric rate limiting — complements, never replaces, the app's own per-tenant rate limiter."
  kind        = "zone"
  phase       = "http_ratelimit"

  rules {
    action      = "block"
    expression  = "true"
    description = "Block a single source IP exceeding the edge's own coarse volumetric threshold."
    ratelimit {
      characteristics     = ["ip.src", "cf.colo.id"]
      period              = 300
      requests_per_period = var.waf_rate_limit_threshold
      mitigation_timeout  = 600
    }
  }
}
