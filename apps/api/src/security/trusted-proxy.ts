import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';

const DEFAULT_TRUSTED_PROXY_HOPS = 0;

/**
 * Phase 6.3 (edge security) — makes `req.ip` (already the ONLY thing this
 * codebase reads for a client's address: `AuditInterceptor`'s `ip` field,
 * `esignature`'s `ipAddress` capture) resolve the REAL originating client
 * behind whatever reverse-proxy hops sit in front of this process in a
 * given deployment, instead of the address of the nearest hop itself.
 *
 * Express's own `trust proxy` setting (`app.set('trust proxy', N)`,
 * consulted by `req.ip`/`req.ips` via the `proxy-addr` library Express
 * already depends on — no new dependency here) is a COUNT of hops to
 * trust, walking `X-Forwarded-For` from the RIGHT (closest to this
 * process) and treating the first address past that count as the real
 * client. This app's real topology (see
 * docs/conventions/deployment-scaling.md → `deploy/k8s/base/ingress.yaml`)
 * always has AT LEAST one hop — the nginx ingress controller itself, which
 * already sets `X-Forwarded-For` when proxying to a pod — before a
 * request reaches this process; a CDN/WAF placed in front of that ingress
 * (see `deploy/edge/`) adds ONE MORE hop. `TRUSTED_PROXY_HOPS` names
 * exactly how many hops THIS deployment has in front of it (the k8s
 * ConfigMap default is `1`, for the ingress alone; a region with a CDN/WAF
 * in front bumps it to `2` — see `deploy/edge/README.md`).
 *
 * **The default (`0`, unset) is DELIBERATELY "trust nothing"** — the same
 * "no setup needed for local dev, and never insecure by default" posture
 * every other env-gated seam in this codebase takes (`DEPLOYMENT_REGION`,
 * `PLATFORM_MODE_ENABLED`, ...). With `TRUSTED_PROXY_HOPS` unset, Express's
 * `trust proxy` stays at its own default (`false`) and `req.ip` is the
 * TCP socket's own remote address — a caller sending a spoofed
 * `X-Forwarded-For` header directly at this process (no real proxy in
 * front at all — the common case for local dev, CI, and a lifetime/
 * on-prem customer's own reverse proxy they haven't declared here yet)
 * gets IGNORED, not trusted. Setting this to a hop count you do NOT
 * actually have in front of you is a real spoofing vector — the count
 * must match the deployment's actual proxy chain exactly, never guessed
 * high "just in case".
 *
 * See `apps/api/test/edge-client-ip.e2e-spec.ts` for the proof, both
 * directions: a trusted hop correctly resolves a forwarded client IP, and
 * an untrusted (default) configuration refuses to be spoofed by the same
 * header.
 */
export function configureTrustedProxy(app: NestExpressApplication, config: ConfigService): void {
  const hops = Number(config.get<string>('TRUSTED_PROXY_HOPS') ?? DEFAULT_TRUSTED_PROXY_HOPS);
  app.set('trust proxy', hops > 0 ? hops : false);
}
