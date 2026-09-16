/**
 * Phase 6.4 — chaos experiment #5: "an instance killed via SIGTERM
 * mid-request -> graceful drain, no dropped in-flight work, other
 * instances keep serving." See
 * docs/conventions/incident-response-dr.md § Chaos experiments.
 *
 * `deployment-scaling.e2e-spec.ts` (5.3) already proves statelessness
 * across two independent `AppModule` COMPILATIONS living in the SAME OS
 * process (an in-process stand-in for "two pods"), and
 * `resilience.e2e-spec.ts` proves readiness flips unhealthy the instant
 * `ShutdownService.beginShutdown()` is called directly. Neither actually
 * exercises `main.ts`'s own real `process.on('SIGTERM', ...)` handler —
 * that code only runs when `main.ts` itself boots a process, which
 * `Test.createTestingModule` deliberately bypasses. THIS file is the one
 * chaos experiment in this suite that spawns REAL, SEPARATE OS
 * processes (`node dist/main.js`, the exact artifact `deploy/k8s/
 * base/api-deployment.yaml` runs) — two of them, on distinct ports,
 * standing in for two real pods — and sends an ACTUAL `SIGTERM` to one
 * mid-request, over real HTTP, the closest this sandboxed environment can
 * get to a real rolling-update pod eviction without an actual cluster.
 *
 * Requires local infra up, migrations applied, AND a fresh
 * `pnpm --filter @hrm/api build` (this file spawns the compiled
 * `apps/api/dist/main.js`, not the TypeScript source):
 *   docker compose up -d postgres redis
 *   pnpm --filter @hrm/db exec prisma migrate deploy
 *   pnpm --filter @hrm/api build
 */
import { ChildProcess, spawn } from 'node:child_process';
import path from 'node:path';
import { JwtService } from '@nestjs/jwt';
import { prisma, seedSystemRolesAndPermissions, SYSTEM_ROLES } from '@hrm/db';

const TENANT_SLUG = 'chaos-sigterm-drain-tenant';
const PORT_A = 3591;
const PORT_B = 3592;
const GRACE_PERIOD_MS = 2000;
const API_DIST_ENTRY = path.join(__dirname, '..', '..', 'dist', 'main.js');

const jwt = new JwtService({ secret: process.env.JWT_SECRET });

function spawnInstance(port: number): ChildProcess {
  return spawn('node', [API_DIST_ENTRY], {
    cwd: path.join(__dirname, '..', '..'),
    env: { ...process.env, PORT: String(port), SHUTDOWN_GRACE_PERIOD_MS: String(GRACE_PERIOD_MS) },
    stdio: 'ignore',
  });
}

async function waitForHttp(port: number, path_: string, { tries = 100, delayMs = 200 } = {}): Promise<boolean> {
  for (let i = 0; i < tries; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}${path_}`);
      if (res.status < 500) {
        return true;
      }
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return false;
}

async function waitForRefused(port: number, { tries = 50, delayMs = 200 } = {}): Promise<boolean> {
  for (let i = 0; i < tries; i += 1) {
    try {
      await fetch(`http://127.0.0.1:${port}/health`);
    } catch {
      return true; // connection refused/reset — the process has actually stopped listening.
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return false;
}

async function resetFixtures() {
  await prisma.tenant.deleteMany({ where: { slug: TENANT_SLUG } });
}

describe('chaos: real SIGTERM against a real spawned instance drains in-flight work while a sibling instance keeps serving (e2e)', () => {
  let instanceA: ChildProcess;
  let instanceB: ChildProcess;
  let token: string;
  let tenantId: string;

  beforeAll(async () => {
    await resetFixtures();
    const tenant = await prisma.tenant.create({
      data: { name: 'Chaos SIGTERM Drain Tenant', slug: TENANT_SLUG, defaultCountryCode: 'US', hostingRegion: 'us-east-1' },
    });
    tenantId = tenant.id;
    await seedSystemRolesAndPermissions(prisma, tenant.id);
    const role = await prisma.role.findUniqueOrThrow({
      where: { tenantId_name: { tenantId: tenant.id, name: SYSTEM_ROLES.EMPLOYEE } },
    });
    const user = await prisma.user.create({
      data: { tenantId: tenant.id, email: 'user@chaos-sigterm.test', hashedPassword: 'unused', status: 'ACTIVE' },
    });
    await prisma.userRole.create({ data: { tenantId: tenant.id, userId: user.id, roleId: role.id } });
    token = jwt.sign({ sub: user.id, tenantId: tenant.id });

    instanceA = spawnInstance(PORT_A);
    instanceB = spawnInstance(PORT_B);
    const [upA, upB] = await Promise.all([waitForHttp(PORT_A, '/health'), waitForHttp(PORT_B, '/health')]);
    if (!upA || !upB) {
      throw new Error('one or both chaos instances never became reachable — check `pnpm --filter @hrm/api build` ran first.');
    }
  }, 60000);

  afterAll(async () => {
    await resetFixtures();
    for (const child of [instanceA, instanceB]) {
      if (child && !child.killed) {
        child.kill('SIGKILL');
      }
    }
  });

  it('SIGTERM to instance A: readiness flips unhealthy immediately, the in-flight request still completes, and instance B is unaffected throughout', async () => {
    // Start a request that holds open for longer than the grace period,
    // exactly like a real request still being served when eviction begins.
    const inFlight = fetch(`http://127.0.0.1:${PORT_A}/resilience/demo/slow?ms=${GRACE_PERIOD_MS + 1500}`, {
      headers: { 'x-tenant-id': tenantId, Authorization: `Bearer ${token}` },
    });

    // Give it a moment to genuinely be in flight before the signal.
    await new Promise((resolve) => setTimeout(resolve, 300));
    instanceA.kill('SIGTERM');

    // Readiness on A must flip unhealthy WELL before the process actually
    // exits — this is the signal a real load balancer stops routing on.
    const readyFlipped = await (async () => {
      for (let i = 0; i < 20; i += 1) {
        try {
          const res = await fetch(`http://127.0.0.1:${PORT_A}/health/ready`);
          if (res.status === 503) {
            return true;
          }
        } catch {
          return false; // it already closed — too late to observe the flip, treat as a failure of THIS assertion's timing.
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return false;
    })();
    expect(readyFlipped).toBe(true);

    // Instance B — never touched — keeps serving normal requests the
    // ENTIRE time A is draining, proving this is a per-instance event,
    // not a shared/global one (the same statelessness property 5.3's own
    // suite proves in-process, now proven across REAL separate processes).
    const bDuringDrain = await fetch(`http://127.0.0.1:${PORT_B}/resilience/demo/critical`, {
      headers: { 'x-tenant-id': tenantId, Authorization: `Bearer ${token}` },
    });
    expect(bDuringDrain.status).toBe(200);

    // THE CORE CLAIM: the request that was ALREADY in flight when SIGTERM
    // arrived completes successfully — never dropped, never reset —
    // because main.ts waits out SHUTDOWN_GRACE_PERIOD_MS AND Node's
    // server.close() semantics (via app.close()) before actually closing.
    const inFlightResult = await inFlight;
    expect(inFlightResult.status).toBe(200);
    const body = (await inFlightResult.json()) as { sleptMs: number };
    expect(body.sleptMs).toBeGreaterThan(0);

    // After the grace period, instance A actually stops accepting new
    // connections — a real, observable process exit, not a hang.
    const refused = await waitForRefused(PORT_A);
    expect(refused).toBe(true);

    // Instance B is STILL completely unaffected after A has fully exited.
    const bAfterExit = await fetch(`http://127.0.0.1:${PORT_B}/health/ready`);
    expect(bAfterExit.status).toBe(200);
  }, 45000);
});
