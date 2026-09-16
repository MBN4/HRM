# Phase 6.3 (edge security) — CDN cache configuration-as-code for
# Cloudflare. See docs/conventions/edge-security.md and README.md in this
# directory for the full "why" — the single most important rule here is
# the FIRST one: respect the origin's own Cache-Control, never
# second-guess it. NOT applied anywhere — see ../waf/cloudflare-waf-ruleset.tf's
# own top-of-file note on why (no account, no terraform binary available
# to even validate this file's syntax in the environment this was
# authored in).

variable "cloudflare_zone_id" {
  type        = string
  description = "Same zone as ../waf/cloudflare-waf-ruleset.tf — one zone, multiple ruleset phases."
}

# --- 1. THE critical rule: respect origin Cache-Control, always ---
# apps/api's own CacheControlInterceptor + defaultCacheControlMiddleware
# (step 6.3) already set the CORRECT Cache-Control on every response —
# `no-store` by default, an explicit `public, max-age=...` only on routes
# reviewed and marked cacheable (see CareersController). The CDN's own job
# is to TRUST that, never override it — a CDN that force-caches based on
# status code/content-type alone, ignoring a `no-store` the origin
# explicitly sent, is exactly the cross-tenant-leak failure mode this
# step's own test suite (`edge-cache-control.e2e-spec.ts`) exists to catch
# on the APP side; this rule is the matching EDGE-side guarantee.
resource "cloudflare_ruleset" "respect_origin_cache_control" {
  zone_id     = var.cloudflare_zone_id
  name        = "hrm-respect-origin-cache-control"
  description = "Cache exactly what the origin's own Cache-Control says to cache — never override, never force-cache a no-store response."
  kind        = "zone"
  phase       = "http_request_cache_settings"

  rules {
    action     = "set_cache_settings"
    expression = "true"
    action_parameters {
      cache               = true
      origin_cache_control = true
      cache_key {
        ignore_query_strings_order = false
      }
    }
    description = "Zone-wide default: origin_cache_control=true means Cloudflare caches (or doesn't) exactly per the response's own Cache-Control header — a no-store/private response is never cached regardless of status code or path."
  }
}

# --- 2. The ONE deliberate override: hashed, immutable Next.js static assets ---
# apps/portal / apps/admin's own `_next/static/*` files are content-hashed
# by Next.js's build (a filename changes iff its content changes) — safe
# for the LONGEST possible edge+browser TTL by construction. These are
# served by a DIFFERENT origin than apps/api (the portal/admin Next.js
# servers themselves, per deploy/k8s/base/ingress.yaml's own path split),
# so this is a narrow, path-scoped override, never applied to any
# apps/api response.
resource "cloudflare_ruleset" "immutable_static_assets" {
  zone_id     = var.cloudflare_zone_id
  name        = "hrm-immutable-static-assets"
  description = "Long-TTL override for content-hashed Next.js static assets only — apps/api's own responses are NEVER matched by this rule."
  kind        = "zone"
  phase       = "http_request_cache_settings"

  rules {
    action     = "set_cache_settings"
    expression = "(http.request.uri.path contains \"/_next/static/\")"
    action_parameters {
      cache = true
      edge_ttl {
        mode    = "override_origin"
        default = 31536000
      }
      browser_ttl {
        mode    = "override_origin"
        default = 31536000
      }
    }
    description = "1-year edge+browser TTL for hashed, immutable static assets — safe because the filename itself changes whenever the content does."
  }
}
