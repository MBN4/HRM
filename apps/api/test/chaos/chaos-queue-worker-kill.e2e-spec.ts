/**
 * Phase 6.4 — chaos experiment #3: "queue/worker killed mid-job -> job
 * resumes/retries with no double-apply." See
 * docs/conventions/incident-response-dr.md § Chaos experiments.
 *
 * Reuses the REAL, already-idempotent/resumable payroll run pipeline
 * (2.1) rather than inventing a new one — see `PayrollRunProcessor`'s own
 * doc comment for the two-layer mechanism this proves: (1) Redis
 * `IdempotencyService` claims `<tenantId>:<runId>:<employeeId>` before
 * doing any per-employee work; (2) `PayrollRunLine`'s own
 * `@@unique([tenantId, payrollRunId, employeeId])` is a DATABASE-layer
 * backstop. `payroll.e2e-spec.ts`'s own "resumability" suite already
 * proves a single BROKEN employee doesn't block the rest of a run; THIS
 * file proves the stronger, more literal chaos claim the brief asks for:
 * the WORKER PROCESS ITSELF dying partway through the per-employee loop
 * — not one employee's computation failing, but the loop being torn down
 * entirely with some employees done and others never even attempted, the
 * same shape a real container SIGKILL mid-job would produce — followed by
 * BullMQ's own configured retry (`attempts: 5`, see
 * `payroll-run-queue.service.ts`) re-invoking the SAME job from scratch.
 *
 * The "kill" is simulated by monkey-patching the processor's own private
 * per-employee step to throw once a target employee is reached — this
 * escapes `PayrollRunProcessor.process`'s `for` loop UNCAUGHT (unlike a
 * single employee's own computation error, which that loop's per-employee
 * try/catch already swallows into a FAILED line and continues past) —
 * this is deliberately a DIFFERENT failure shape from that existing test,
 * proven separately here. Every other line of code exercised (the real
 * engine, the real Redis idempotency claim, the real Postgres
 * transactions) is exactly what production runs through — nothing here
 * is mocked except the single injected kill point.
 *
 * Requires local infra up and migrations applied:
 *   docker compose up -d postgres redis
 *   pnpm --filter @hrm/db exec prisma migrate deploy
 */
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import type { Job } from 'bullmq';
import { appPrisma, prisma, seedCountryPacks, seedSystemRolesAndPermissions } from '@hrm/db';
import type IORedis from 'ioredis';
import { AppModule } from '../../src/app.module';
import { REDIS_CLIENT } from '../../src/redis/redis.constants';
import { PayrollRunProcessor } from '../../src/payroll/runs/payroll-run.processor';
import type { PayrollRunJobData } from '../../src/payroll/runs/payroll-run-queue.service';

const TENANT_SLUG = 'chaos-queue-kill-tenant';

async function resetFixtures() {
  await prisma.tenant.deleteMany({ where: { slug: TENANT_SLUG } });
}

async function makeEmployee(tenantId: string, branchId: string, code: string) {
  return prisma.employee.create({
    data: {
      tenantId,
      branchId,
      employeeCode: code,
      firstName: 'Chaos',
      lastName: code,
      employmentType: 'FULL_TIME',
      joinDate: new Date('2020-01-01'),
      status: 'ACTIVE',
    },
  });
}

describe('chaos: BullMQ worker killed mid-job, then retried (payroll run) (e2e)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let tenantId: string;
  let branchId: string;
  let processor: PayrollRunProcessor;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    processor = moduleRef.get(PayrollRunProcessor);

    await resetFixtures();
    await seedCountryPacks(prisma);
    const tenant = await prisma.tenant.create({
      data: { name: 'Chaos Queue Kill Tenant', slug: TENANT_SLUG, defaultCountryCode: 'US', hostingRegion: 'us-east-1' },
    });
    tenantId = tenant.id;
    await seedSystemRolesAndPermissions(prisma, tenantId);
    const branch = await prisma.branch.create({
      data: { tenantId, name: 'Chaos Queue Kill Branch', countryCode: 'US', timezone: 'America/New_York' },
    });
    branchId = branch.id;

    await Promise.all(['E1', 'E2', 'E3', 'E4'].map((code) => makeEmployee(tenantId, branchId, code)));
  }, 30000);

  afterAll(async () => {
    await resetFixtures();
    await appPrisma.$disconnect();
    await moduleRef.get<IORedis>(REDIS_CLIENT).quit();
    await app.close();
  });

  it('a worker "killed" partway through the loop leaves some employees COMPUTED and none double-applied on retry', async () => {
    const run = await prisma.payrollRun.create({
      data: { tenantId, branchId, periodYear: 2026, periodMonth: 8, currencyCode: 'USD', status: 'DRAFT', payrollMode: 'CALCULATE' },
    });
    const jobData: PayrollRunJobData = { tenantId, payrollRunId: run.id };
    const fakeJob = { data: jobData } as Job<PayrollRunJobData>;

    // Monkey-patch the processor's own private per-employee step: run the
    // REAL implementation for the first two employees `process()`
    // actually iterates to (the processor's own query has no `orderBy`,
    // so which two employees that is is NOT assumed here — only observed
    // from the real call sequence), then throw on the 3rd — simulating
    // the process dying at exactly that point, escaping the loop
    // UNCAUGHT (unlike a real per-employee computation error, which is
    // caught internally and recorded as a FAILED line instead of
    // aborting the job).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const proc = processor as any;
    const original = proc.processEmployee.bind(proc);
    let callCount = 0;
    const processedBeforeKill: string[] = [];
    const killSpy = jest.spyOn(proc, 'processEmployee').mockImplementation(async (...args: unknown[]) => {
      callCount += 1;
      const employeeId = args[3] as string;
      if (callCount === 3) {
        throw new Error('chaos: simulated worker SIGKILL mid-job');
      }
      processedBeforeKill.push(employeeId);
      return original(...args);
    });

    await expect(processor.process(fakeJob)).rejects.toThrow('chaos: simulated worker SIGKILL mid-job');

    const linesAfterKill = await prisma.payrollRunLine.findMany({ where: { payrollRunId: run.id } });
    const computedAfterKill = linesAfterKill.filter((l) => l.status === 'COMPUTED');
    // Exactly the two employees processed BEFORE the kill were computed;
    // the kill target and everything after it never even ran (only 2
    // lines exist at all — the kill target and the 4th employee never
    // got a line row written).
    expect(computedAfterKill.map((l) => l.employeeId).sort()).toEqual([...processedBeforeKill].sort());
    expect(linesAfterKill).toHaveLength(2);
    const computedAtBeforeRetry = new Map(computedAfterKill.map((l) => [l.employeeId, l.computedAt?.toISOString()]));

    const runAfterKill = await prisma.payrollRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(runAfterKill.status).not.toBe('CALCULATED'); // the job never reached recomputeTotals.

    // Simulate BullMQ's own retry (attempts: 5, see
    // payroll-run-queue.service.ts): restore the REAL implementation and
    // re-invoke `process()` with the IDENTICAL job data, exactly what a
    // real retried BullMQ attempt does.
    killSpy.mockRestore();
    await processor.process(fakeJob);

    const linesAfterRetry = await prisma.payrollRunLine.findMany({ where: { payrollRunId: run.id } });
    expect(linesAfterRetry).toHaveLength(4);
    expect(linesAfterRetry.every((l) => l.status === 'COMPUTED')).toBe(true);

    // THE NO-DOUBLE-APPLY PROOF: the two employees that were ALREADY
    // COMPUTED before the simulated kill were never reprocessed — their
    // `computedAt` timestamps are byte-identical across the retry, proof
    // the idempotency claim (Redis) + the unique-constraint backstop
    // (Postgres) together skip already-done work rather than
    // recomputing/re-crediting it.
    for (const [employeeId, computedAt] of computedAtBeforeRetry) {
      const lineAfterRetry = linesAfterRetry.find((l) => l.employeeId === employeeId)!;
      expect(lineAfterRetry.computedAt?.toISOString()).toBe(computedAt);
    }

    const runAfterRetry = await prisma.payrollRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(runAfterRetry.status).toBe('CALCULATED');
    expect(runAfterRetry.totalGross.toNumber()).toBeGreaterThanOrEqual(0);
  }, 30000);
});
