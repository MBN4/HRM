/**
 * The access token lives ONLY in memory (a module-level variable) — it's
 * short-lived (JWT_EXPIRES_IN, 15m default) and never needs to survive a
 * reload; the refresh token (opaque, 0.4's Redis-tracked, rotating) is
 * persisted in localStorage so a reload/new-tab doesn't force a re-login,
 * mirroring the two-token model's own lifetimes rather than inventing a
 * third storage policy.
 */
const REFRESH_TOKEN_KEY = 'hrm.refreshToken';

let accessToken: string | null = null;

export function getAccessToken(): string | null {
  return accessToken;
}

export function setTokens(newAccessToken: string, newRefreshToken: string): void {
  accessToken = newAccessToken;
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(REFRESH_TOKEN_KEY, newRefreshToken);
  } catch {
    // Storage unavailable — the session still works for this tab via the
    // in-memory access token; a reload will simply require re-login.
  }
}

export function getRefreshToken(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(REFRESH_TOKEN_KEY);
  } catch {
    return null;
  }
}

export function clearTokens(): void {
  accessToken = null;
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(REFRESH_TOKEN_KEY);
  } catch {
    // Nothing more to do — the in-memory token is already cleared.
  }
}
