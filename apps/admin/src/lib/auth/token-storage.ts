/**
 * The access token lives ONLY in memory — short-lived
 * (PLATFORM_JWT_EXPIRES_IN, 30m default) and never needs to survive a
 * reload. The refresh token is persisted in localStorage under a key
 * distinct from apps/portal's own (`hrm.refreshToken`) so the two apps'
 * sessions can never collide even if someone runs both against the same
 * browser profile — see docs/conventions/vendor-console.md.
 */
const REFRESH_TOKEN_KEY = 'hrm-admin.platformRefreshToken';

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
