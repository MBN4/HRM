import * as SecureStore from 'expo-secure-store';

/**
 * Mirrors apps/portal's src/lib/auth/token-storage.ts's two-token split
 * (see docs/conventions/auth-rbac.md's "Two-token model"): the short-lived
 * access token lives ONLY in memory (a module-level variable — never
 * needs to survive a reload); the rotating opaque refresh token is
 * persisted so a cold app launch doesn't force a re-login. The portal uses
 * localStorage for that (a browser tab always has it); this app uses
 * `expo-secure-store` instead — the task brief calls this out explicitly
 * as STRONGER than the portal's choice (OS-level encrypted storage, iOS
 * Keychain / Android Keystore) rather than a downgrade, appropriate for a
 * native app that has that capability and localStorage does not map to.
 */
const REFRESH_TOKEN_KEY = 'hrm.refreshToken';

let accessToken: string | null = null;

export function getAccessToken(): string | null {
  return accessToken;
}

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export async function setTokens(newAccessToken: string, newRefreshToken: string): Promise<void> {
  accessToken = newAccessToken;
  try {
    await SecureStore.setItemAsync(REFRESH_TOKEN_KEY, newRefreshToken);
  } catch {
    // Storage unavailable — the session still works for this app run via
    // the in-memory access token; a restart will simply require re-login.
  }
}

export async function getRefreshToken(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(REFRESH_TOKEN_KEY);
  } catch {
    return null;
  }
}

export async function clearTokens(): Promise<void> {
  accessToken = null;
  try {
    await SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY);
  } catch {
    // Nothing more to do — the in-memory token is already cleared.
  }
}
