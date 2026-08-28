import { resolveTenant, TENANT_HEADER } from '../tenant';
import { clearTokens, getAccessToken, getRefreshToken, setTokens } from '../auth/token-storage';

export class ApiError extends Error {
  status: number;
  body: unknown;

  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export interface ApiRequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  /** Skips attaching an Authorization header and the 401-refresh dance — for login/refresh/password-reset. */
  skipAuth?: boolean;
}

function buildUrl(base: string, path: string, query?: ApiRequestOptions['query']): string {
  const normalizedBase = base.endsWith('/') ? base : `${base}/`;
  const url = new URL(path.replace(/^\//, ''), normalizedBase);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value));
      }
    }
  }
  return url.toString();
}

// A single in-flight refresh is shared by every request that races into a
// 401 at once, so a page that fires several requests on mount only ever
// triggers ONE rotation instead of a burst that would trip 0.4's refresh
// reuse detection against itself.
let inFlightRefresh: Promise<string | null> | null = null;

async function performRefresh(apiBaseUrl: string): Promise<string | null> {
  const refreshToken = getRefreshToken();
  if (!refreshToken) return null;
  try {
    const res = await fetch(buildUrl(apiBaseUrl, '/auth/refresh'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
    if (!res.ok) {
      clearTokens();
      return null;
    }
    const data = (await res.json()) as { accessToken: string; refreshToken: string };
    setTokens(data.accessToken, data.refreshToken);
    return data.accessToken;
  } catch {
    return null;
  }
}

async function request<T>(path: string, opts: ApiRequestOptions, isRetry: boolean): Promise<T> {
  const { apiBaseUrl, headerTenantId } = resolveTenant();
  const headers: Record<string, string> = {};
  if (headerTenantId) {
    headers[TENANT_HEADER] = headerTenantId;
  }

  let body: BodyInit | undefined;
  if (opts.body instanceof FormData) {
    body = opts.body;
  } else if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }

  if (!opts.skipAuth) {
    const token = getAccessToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }

  const res = await fetch(buildUrl(apiBaseUrl, path, opts.query), {
    method: opts.method ?? 'GET',
    headers,
    body,
  });

  if (res.status === 401 && !opts.skipAuth && !isRetry) {
    inFlightRefresh ??= performRefresh(apiBaseUrl).finally(() => {
      inFlightRefresh = null;
    });
    const newToken = await inFlightRefresh;
    if (newToken) {
      return request<T>(path, opts, true);
    }
    clearTokens();
    if (typeof window !== 'undefined' && !window.location.pathname.startsWith('/login')) {
      window.location.href = '/login';
    }
    throw new ApiError(401, 'Your session has expired. Please sign in again.', null);
  }

  if (res.status === 204) {
    return undefined as T;
  }

  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;

  if (!res.ok) {
    const rawMessage = data && typeof data === 'object' ? (data as { message?: unknown }).message : undefined;
    const message = Array.isArray(rawMessage) ? rawMessage.join(', ') : (rawMessage as string) || res.statusText;
    throw new ApiError(res.status, message, data);
  }

  return data as T;
}

export function apiFetch<T = unknown>(path: string, opts: ApiRequestOptions = {}): Promise<T> {
  return request<T>(path, opts, false);
}
