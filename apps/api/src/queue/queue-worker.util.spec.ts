import { shouldAutorunWorkers } from './queue-worker.util';

describe('shouldAutorunWorkers', () => {
  const original = process.env.PROCESS_ROLE;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.PROCESS_ROLE;
    } else {
      process.env.PROCESS_ROLE = original;
    }
  });

  it('is false when PROCESS_ROLE=api — the api Deployment must never also consume queues', () => {
    process.env.PROCESS_ROLE = 'api';
    expect(shouldAutorunWorkers()).toBe(false);
  });

  it('is true when PROCESS_ROLE is unset — worker.ts runs with no PROCESS_ROLE set', () => {
    delete process.env.PROCESS_ROLE;
    expect(shouldAutorunWorkers()).toBe(true);
  });

  it('is true for any other value (e.g. "worker", "all") — only the literal "api" opts out', () => {
    process.env.PROCESS_ROLE = 'worker';
    expect(shouldAutorunWorkers()).toBe(true);
    process.env.PROCESS_ROLE = 'all';
    expect(shouldAutorunWorkers()).toBe(true);
  });
});
