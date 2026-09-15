import { PassThrough } from 'node:stream';
import { PinoLoggerService } from './pino-logger.service';
import { requestContextStorage } from './request-context.store';
import { tenantContextStorage } from '../../tenancy/tenant-context.store';
import type { RequestTenantStore } from '../../tenancy/tenant-context.store';

function readLines(chunks: string[]): Record<string, unknown>[] {
  return chunks
    .join('')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const EMPTY_TENANT_STORE: RequestTenantStore = {
  tenantId: null,
  branchId: null,
  userId: null,
  roles: null,
  permissions: null,
  branchIds: null,
  platform: false,
  platformAdminId: null,
  platformRole: null,
  impersonatedByPlatformAdminId: null,
  tx: null,
};

function createLogger(errorTracker = { captureException: jest.fn() }) {
  const chunks: string[] = [];
  const destination = new PassThrough();
  destination.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')));
  const logger = new PinoLoggerService({ serviceName: 'test-service', destination, errorTracker, level: 'trace' });
  return { logger, chunks, errorTracker };
}

describe('PinoLoggerService', () => {
  it('emits structured JSON with a service field', () => {
    const { logger, chunks } = createLogger();
    logger.log('hello world', 'SomeContext');
    const [line] = readLines(chunks);
    expect(line.service).toBe('test-service');
    expect(line.context).toBe('SomeContext');
    expect(line.msg).toBe('hello world');
    expect(typeof line.time).toBe('string');
  });

  it('correlates a log line with the current requestId AND tenant context, automatically', async () => {
    const { logger, chunks } = createLogger();

    await requestContextStorage.run({ requestId: 'req-123' }, () =>
      tenantContextStorage.run({ ...EMPTY_TENANT_STORE, tenantId: 'tenant-abc', userId: 'user-xyz' }, () => {
        logger.log('inside request context');
        return Promise.resolve();
      }),
    );

    const [line] = readLines(chunks);
    expect(line.requestId).toBe('req-123');
    expect(line.tenantId).toBe('tenant-abc');
    expect(line.userId).toBe('user-xyz');
  });

  it('carries NO correlation fields outside any request context', () => {
    const { logger, chunks } = createLogger();
    logger.log('no context here');
    const [line] = readLines(chunks);
    expect(line.requestId).toBeUndefined();
    expect(line.tenantId).toBeUndefined();
  });

  it('redacts a sensitive field (password/token/salary-shaped keys) instead of logging it in the clear', () => {
    const { logger, chunks } = createLogger();
    logger.log({
      userId: 'user-1',
      password: 'super-secret',
      compensation: { baseSalary: 250000 },
      ssn: '123-45-6789',
    });
    const [line] = readLines(chunks);
    expect(line.userId).toBe('user-1');
    expect(line.password).toBe('[REDACTED]');
    expect(line.compensation).toBe('[REDACTED]');
    expect(line.ssn).toBe('[REDACTED]');
    expect(JSON.stringify(line)).not.toContain('super-secret');
    expect(JSON.stringify(line)).not.toContain('123-45-6789');
  });

  it('forwards .error() calls to the error tracker with only scrubbed correlation context, never the raw message', () => {
    const { logger, chunks, errorTracker } = createLogger();
    const err = new Error('boom');
    logger.error(err, 'SomeContext');

    expect(errorTracker.captureException).toHaveBeenCalledTimes(1);
    const [capturedError, capturedContext] = errorTracker.captureException.mock.calls[0];
    expect(capturedError).toBe(err);
    expect(capturedContext).toEqual({
      requestId: undefined,
      tenantId: undefined,
      userId: undefined,
      context: 'SomeContext',
    });

    const [line] = readLines(chunks);
    expect(line.errorMessage).toBe('boom');
    expect(typeof line.stack).toBe('string');
  });

  it('does NOT forward log/warn/debug calls to the error tracker — only .error()', () => {
    const { logger, errorTracker } = createLogger();
    logger.log('fine');
    logger.warn('also fine');
    logger.debug('still fine');
    expect(errorTracker.captureException).not.toHaveBeenCalled();
  });
});
