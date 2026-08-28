import { API_BASE_URL, getStoredTenantSlug, TENANT_HEADER } from '../tenant';
import { clearTokens, getAccessToken, getRefreshToken, setTokens } from '../auth/tokenStorage';

/**
 * Mirrors apps/portal/src/lib/api/client.ts's `apiFetch`/`ApiError`/
 * single-in-flight-refresh-dedup shape (see docs/conventions/auth-rbac.md's
 * "Two-token model" + "Refresh rotation") — adapted for React Native:
 * `fetch`/`FormData`/`URL` all exist in this runtime, but token storage is
 * async here (SecureStore, not localStorage — see ../auth/tokenStorage.ts)
 * and there is no `window.location` to bounce to `/login` on an
 * unrecoverable 401; that's the caller's (AuthContext's) job via its own
 * `user` state driving navigation instead.
 */
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
// 401 at once — same reasoning as the portal's client: only ever ONE
// rotation per burst, so we never trip 0.4's refresh reuse detection
// against ourselves.
let inFlightRefresh: Promise<string | null> | null = null;

// The portal bounces to `/login` via `window.location.href` on an
// unrecoverable 401 (see its client.ts) — there is no such global
// location here, so AuthContext registers itself as this listener instead
// and clears its `user` state, which the navigator (App.tsx) already
// treats as "show the Login screen".
let onSessionExpired: (() => void) | null = null;

export function setSessionExpiredHandler(handler: (() => void) | null): void {
  onSessionExpired = handler;
}

async function performRefresh(): Promise<string | null> {
  const refreshToken = await getRefreshToken();
  if (!refreshToken) return null;
  try {
    const res = await fetch(buildUrl(API_BASE_URL, '/auth/refresh'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
    if (!res.ok) {
      await clearTokens();
      return null;
    }
    const data = (await res.json()) as { accessToken: string; refreshToken: string };
    await setTokens(data.accessToken, data.refreshToken);
    return data.accessToken;
  } catch {
    return null;
  }
}

async function request<T>(path: string, opts: ApiRequestOptions, isRetry: boolean): Promise<T> {
  const headers: Record<string, string> = {};
  const tenantSlug = await getStoredTenantSlug();
  if (tenantSlug) {
    headers[TENANT_HEADER] = tenantSlug;
  }

  let body: BodyInit | undefined;
  if (opts.body instanceof FormData) {
    body = opts.body;
    // Deliberately no 'Content-Type' header for FormData — fetch/React
    // Native sets the multipart boundary itself; overriding it here would
    // drop the boundary parameter and break the upload server-side.
  } else if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }

  if (!opts.skipAuth) {
    const token = getAccessToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }

  const res = await fetch(buildUrl(API_BASE_URL, path, opts.query), {
    method: opts.method ?? 'GET',
    headers,
    body,
  });

  if (res.status === 401 && !opts.skipAuth && !isRetry) {
    inFlightRefresh ??= performRefresh().finally(() => {
      inFlightRefresh = null;
    });
    const newToken = await inFlightRefresh;
    if (newToken) {
      return request<T>(path, opts, true);
    }
    await clearTokens();
    onSessionExpired?.();
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
