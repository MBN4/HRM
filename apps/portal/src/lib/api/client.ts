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

/**
 * Builds the request, attaches tenant/auth headers, and — for anything but
 * a `skipAuth`/already-retried call — transparently rotates a 401 through
 * the SAME single-flight `performRefresh` and retries once. Shared by both
 * `request()` (JSON) and `apiFetchBlob()` (binary `StreamableFile` routes)
 * so this header/retry logic exists in exactly one place; each caller owns
 * only its own response-body parsing.
 */
async function doFetch(path: string, opts: ApiRequestOptions, isRetry: boolean): Promise<Response> {
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
      return doFetch(path, opts, true);
    }
    clearTokens();
    if (typeof window !== 'undefined' && !window.location.pathname.startsWith('/login')) {
      window.location.href = '/login';
    }
    throw new ApiError(401, 'Your session has expired. Please sign in again.', null);
  }

  return res;
}

async function request<T>(path: string, opts: ApiRequestOptions, isRetry: boolean): Promise<T> {
  const res = await doFetch(path, opts, isRetry);

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

export interface ApiBlobResult {
  blob: Blob;
  filename: string | null;
}

function parseContentDispositionFilename(header: string | null): string | null {
  if (!header) return null;
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(header);
  return match ? decodeURIComponent(match[1]) : null;
}

/**
 * The binary counterpart to `apiFetch` — for the three `StreamableFile`
 * routes (payslip PDF, bank-export CSV) whose response body would corrupt
 * (or throw) if run through `apiFetch`'s `res.text()` -> `JSON.parse`.
 * Shares `doFetch`'s tenant/auth-header + single-flight 401-refresh-retry
 * logic; a non-2xx response is still parsed as JSON when the server
 * responded with one (these routes can still 403/400/404 with a JSON error
 * body), falling back to `res.statusText` otherwise.
 */
export async function apiFetchBlob(
  path: string,
  opts: { method?: 'GET' | 'POST'; query?: ApiRequestOptions['query'] } = {},
): Promise<ApiBlobResult> {
  const res = await doFetch(path, { method: opts.method ?? 'GET', query: opts.query }, false);

  if (!res.ok) {
    const contentType = res.headers.get('content-type') ?? '';
    let data: unknown = null;
    let message = res.statusText;
    if (contentType.includes('application/json')) {
      const text = await res.text();
      data = text ? JSON.parse(text) : null;
      const rawMessage = data && typeof data === 'object' ? (data as { message?: unknown }).message : undefined;
      message = Array.isArray(rawMessage) ? rawMessage.join(', ') : (rawMessage as string) || res.statusText;
    }
    throw new ApiError(res.status, message, data);
  }

  const blob = await res.blob();
  const filename = parseContentDispositionFilename(res.headers.get('content-disposition'));
  return { blob, filename };
}
