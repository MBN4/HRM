/**
 * Pure-logic verification of the URL-building/header-injection/401-refresh
 * behavior in ../client.ts — the piece of this app closest to "business
 * logic" that's actually testable headlessly (no simulator/renderer
 * needed). `expo-secure-store` is mocked with a trivial in-memory map so
 * this runs with no native module and no real device.
 */
import { apiFetch, ApiError, setSessionExpiredHandler } from '../client';
import { setAccessToken, clearTokens } from '../../auth/tokenStorage';
import { setStoredTenantSlug, clearStoredTenantSlug } from '../../tenant';

const mockStore = new Map<string, string>();

// jest-hoisted (babel-plugin-jest-hoist runs this above the imports above
// at transform time regardless of its source position) — physically
// placed after the imports it configures purely so eslint's import/first
// rule doesn't flag it.
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn((key: string) => Promise.resolve(mockStore.get(key) ?? null)),
  setItemAsync: jest.fn((key: string, value: string) => {
    mockStore.set(key, value);
    return Promise.resolve();
  }),
  deleteItemAsync: jest.fn((key: string) => {
    mockStore.delete(key);
    return Promise.resolve();
  }),
}));

function mockFetchOnce(status: number, body: unknown, capture?: (input: RequestInfo | URL, init?: RequestInit) => void) {
  return jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    capture?.(input, init);
    return {
      status,
      ok: status >= 200 && status < 300,
      statusText: 'status',
      text: async () => JSON.stringify(body),
      json: async () => body,
    } as Response;
  });
}

describe('apiFetch', () => {
  beforeEach(async () => {
    mockStore.clear();
    await clearTokens();
    await clearStoredTenantSlug();
    setSessionExpiredHandler(null);
  });

  it('builds the request URL against EXPO_PUBLIC_API_URL and attaches the tenant header when a slug is stored', async () => {
    await setStoredTenantSlug('acme');
    let capturedUrl = '';
    let capturedHeaders: Record<string, string> = {};
    global.fetch = mockFetchOnce(200, { ok: true }, (input, init) => {
      capturedUrl = String(input);
      capturedHeaders = (init?.headers as Record<string, string>) ?? {};
    }) as unknown as typeof fetch;

    await apiFetch('/leave/balances', { query: { employeeId: 'e1' }, skipAuth: true });

    expect(capturedUrl).toBe('http://localhost:3001/leave/balances?employeeId=e1');
    expect(capturedHeaders['x-tenant-id']).toBe('acme');
  });

  it('attaches a Bearer Authorization header from the in-memory access token, unless skipAuth is set', async () => {
    setAccessToken('access-123');
    let capturedHeaders: Record<string, string> = {};
    global.fetch = mockFetchOnce(200, {}, (_input, init) => {
      capturedHeaders = (init?.headers as Record<string, string>) ?? {};
    }) as unknown as typeof fetch;

    await apiFetch('/auth/me');
    expect(capturedHeaders.Authorization).toBe('Bearer access-123');

    let skipAuthHeaders: Record<string, string> = {};
    global.fetch = mockFetchOnce(200, {}, (_input, init) => {
      skipAuthHeaders = (init?.headers as Record<string, string>) ?? {};
    }) as unknown as typeof fetch;
    await apiFetch('/auth/login', { skipAuth: true, method: 'POST', body: { email: 'a@b.com', password: 'x' } });
    expect(skipAuthHeaders.Authorization).toBeUndefined();
  });

  it('throws ApiError with the server-provided message on a non-2xx response', async () => {
    global.fetch = mockFetchOnce(400, { message: 'Bad request' }) as unknown as typeof fetch;
    const promise = apiFetch('/leave/requests', { method: 'POST', body: {} });
    await expect(promise).rejects.toBeInstanceOf(ApiError);
    await expect(promise).rejects.toMatchObject({ status: 400, message: 'Bad request' });
  });

  it('joins an array validation message with commas', async () => {
    global.fetch = mockFetchOnce(400, { message: ['startDate is required', 'endDate is required'] }) as unknown as typeof fetch;
    await expect(apiFetch('/leave/requests', { method: 'POST', body: {} })).rejects.toThrow(
      'startDate is required, endDate is required',
    );
  });

  it('retries once through /auth/refresh on a 401, then succeeds with the new token', async () => {
    setAccessToken('stale-token');
    await setStoredTenantSlug('acme');
    // No refresh token stored — refresh cannot succeed, so the request
    // should surface the session-expired ApiError and call the registered
    // session-expired handler exactly once.
    let expiredCalls = 0;
    setSessionExpiredHandler(() => {
      expiredCalls += 1;
    });
    global.fetch = mockFetchOnce(401, null) as unknown as typeof fetch;

    await expect(apiFetch('/employees/me')).rejects.toThrow('Your session has expired. Please sign in again.');
    expect(expiredCalls).toBe(1);
  });

  it('returns undefined for a 204 No Content response', async () => {
    global.fetch = mockFetchOnce(204, null) as unknown as typeof fetch;
    await expect(apiFetch('/notifications/abc/read', { method: 'POST' })).resolves.toBeUndefined();
  });
});
