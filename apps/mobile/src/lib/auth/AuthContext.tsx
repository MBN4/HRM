import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { apiLogin, apiLogoutAll, apiLogout, apiMe, bootstrapSession } from '../api/auth';
import { clearTokens, setTokens } from './tokenStorage';
import { setSessionExpiredHandler } from '../api/client';
import { setStoredTenantSlug } from '../tenant';
import { deregisterPushToken, registerPushToken, subscribeToPushTokenRotation } from '../push';
import type { MeResponse } from '../api/types';

/**
 * Mirrors apps/portal/src/lib/auth/AuthContext.tsx — deliberately thin: it
 * owns WHO the caller is (`GET /auth/me`'s `roles`/`permissions`/
 * `branchIds`, loaded fresh every session, never cached beyond it) and
 * nothing about WHAT they can see — every screen still calls `can(permission)`
 * itself before rendering a gated action (see
 * docs/conventions/auth-rbac.md). The one mobile-specific addition is push
 * token lifecycle: register on login (and whenever the OS rotates the
 * token, see ../push.ts), deregister on logout — the task brief's "wired
 * to the 0.8 hub" requirement.
 */
export interface AuthContextValue {
  user: MeResponse | null;
  loading: boolean;
  login: (email: string, password: string, tenantSlug: string) => Promise<void>;
  logout: () => Promise<void>;
  logoutAll: () => Promise<void>;
  can: (permission: string) => boolean;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<MeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const pushSubscriptionRef = useRef<{ remove: () => void } | null>(null);

  const refreshUser = useCallback(async () => {
    const me = await apiMe();
    setUser(me);
  }, []);

  useEffect(() => {
    // A 401 that survives the client's own refresh dance (see
    // ../api/client.ts) means the session is unrecoverable — clear local
    // state so the navigator (App.tsx) falls back to the Login screen,
    // the RN equivalent of the portal's `window.location.href = '/login'`.
    setSessionExpiredHandler(() => setUser(null));
    return () => setSessionExpiredHandler(null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const ok = await bootstrapSession();
      if (cancelled) return;
      if (ok) {
        try {
          await refreshUser();
          registerPushToken().catch(() => {});
        } catch {
          await clearTokens();
          setUser(null);
        }
      }
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshUser]);

  useEffect(() => {
    pushSubscriptionRef.current = subscribeToPushTokenRotation();
    return () => pushSubscriptionRef.current?.remove();
  }, []);

  const login = useCallback(
    async (email: string, password: string, tenantSlug: string) => {
      await setStoredTenantSlug(tenantSlug);
      const session = await apiLogin(email, password);
      await setTokens(session.accessToken, session.refreshToken);
      await refreshUser();
      registerPushToken().catch(() => {
        // Best-effort — see ../push.ts's own doc comment.
      });
    },
    [refreshUser],
  );

  const logout = useCallback(async () => {
    await deregisterPushToken();
    try {
      await apiLogout();
    } catch {
      // Best-effort — the token is being cleared client-side regardless.
    }
    await clearTokens();
    setUser(null);
  }, []);

  const logoutAll = useCallback(async () => {
    await deregisterPushToken();
    try {
      await apiLogoutAll();
    } catch {
      // Best-effort — as above.
    }
    await clearTokens();
    setUser(null);
  }, []);

  const can = useCallback((permission: string) => Boolean(user?.permissions?.includes(permission)), [user]);

  const value = useMemo<AuthContextValue>(
    () => ({ user, loading, login, logout, logoutAll, can, refreshUser }),
    [user, loading, login, logout, logoutAll, can, refreshUser],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth() must be used within an <AuthProvider>.');
  }
  return ctx;
}
