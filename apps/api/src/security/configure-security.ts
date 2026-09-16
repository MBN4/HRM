import type { INestApplication } from '@nestjs/common';
import helmet from 'helmet';
import { CorsOriginService } from './cors-origin.service';

/**
 * Secure headers + CORS allow-list (step 6.2) — factored out of `main.ts`
 * so the e2e suite can exercise the SAME wiring against its own
 * `TestingModule`-built app, without duplicating the config. The exact
 * "factor out of main.ts so tests can set it up too" shape `setupSwagger`
 * already established (see that file's own doc comment).
 */
export function configureSecurity(app: INestApplication): void {
  // CSP is tuned, not left at helmet's strict default: `swagger-ui-express`
  // (mounted at /v1/docs by setupSwagger) serves an HTML page with an
  // inline bootstrap `<script>` and inline `<style>`, so `script-src`/
  // `style-src` need `'unsafe-inline'` for that ONE page to keep working —
  // documented here rather than silently disabling CSP for the whole app.
  // TLS itself is terminated at the load balancer/ingress in every real
  // deployment (see deploy/k8s/), never inside this process — `hsts` still
  // makes sense to set here since it's a response header, not a listener
  // option.
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "'unsafe-inline'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
        },
      },
    }),
  );

  // A real allow-list (env-driven base domain + subdomains + verified
  // tenant custom domains, see CorsOriginService), replacing the previous
  // `app.enableCors()` with NO options at all (any origin). `credentials:
  // true` because the portal/admin/mobile clients all rely on this API
  // accepting `Authorization` headers from a browser context.
  const corsOriginService = app.get(CorsOriginService);
  app.enableCors({
    origin: (origin, callback) => {
      corsOriginService
        .isAllowed(origin)
        .then((allowed) => callback(null, allowed))
        .catch((error: unknown) => callback(error as Error, false));
    },
    credentials: true,
  });
}
