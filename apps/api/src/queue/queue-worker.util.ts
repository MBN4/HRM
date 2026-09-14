/**
 * Phase 5.3 — lets a process opt OUT of actually running BullMQ workers
 * while still enqueuing jobs (`@InjectQueue`) and mounting every
 * controller — see docs/conventions/deployment-scaling.md § Separate
 * scalable workloads. The `api` Deployment sets `PROCESS_ROLE=api` so
 * scaling API replicas for request load never also scales queue
 * consumption — that is the dedicated `worker` Deployment's job (see
 * `worker.ts`), scaled on queue depth instead.
 *
 * Every `@Processor(...)` in this codebase passes
 * `{ autorun: shouldAutorunWorkers() }` as its BullMQ `WorkerOptions`.
 * `autorun: false` still constructs the underlying BullMQ `Worker` (so DI/
 * module wiring, health checks, and every existing test are completely
 * unchanged) — it just never starts pulling jobs off Redis, exactly as if
 * this process had no processor for that queue at all.
 *
 * Default (`PROCESS_ROLE` unset, or any value other than `"api"`) is
 * `true` — `worker.ts` runs with no `PROCESS_ROLE` set, and every existing
 * dev/test/e2e invocation of the full API (`main.ts`,
 * `Test.createTestingModule`) is completely unaffected unless it
 * explicitly opts in to `PROCESS_ROLE=api`.
 */
export function shouldAutorunWorkers(): boolean {
  return process.env.PROCESS_ROLE !== 'api';
}
