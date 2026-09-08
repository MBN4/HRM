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
  /** Skips attaching an Authorization header and the 401-refresh dance — for login/mfa/refresh. */
  skipAuth?: boolean;
}

function apiBaseUrl(): string {
  return process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
}

function buildUrl(path: string, query?: ApiRequestOptions['query']): string {
  const base = apiBaseUrl();
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

/**
 * A single in-flight refresh shared by every request that races into a
 * 401 at once — the same "one rotation, not a burst" reasoning
 * apps/portal's own client takes (see that file's doc comment), which
 * matters here too: `PlatformTokenService.rotate` reuse-detects exactly
 * like tenant auth does.
 */
let inFlightRefresh: Promise<string | null> | null = null;

async function performRefresh(): Promise<string | null> {
  const refreshToken = getRefreshToken();
  if (!refreshToken) return null;
  try {
    const res = await fetch(buildUrl('/platform/auth/refresh'), {
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

async function doFetch(path: string, opts: ApiRequestOptions, isRetry: boolean): Promise<Response> {
  const headers: Record<string, string> = {};

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

  const res = await fetch(buildUrl(path, opts.query), { method: opts.method ?? 'GET', headers, body });

  if (res.status === 401 && !opts.skipAuth && !isRetry) {
    inFlightRefresh ??= performRefresh().finally(() => {
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
 * The binary counterpart to `apiFetch` — added for the data migration
 * toolkit's error-report CSV download (step 3.5.1, see
 * docs/conventions/data-migration.md), mirroring `apps/portal`'s own
 * `apiFetchBlob` exactly (see that file's doc comment) — this console had
 * no binary-download route before this step.
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
