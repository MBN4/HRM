'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { apiLogin, apiLogoutAll, apiLogout, apiMe, bootstrapSession } from '../api/auth';
import { clearTokens, setTokens } from './token-storage';
import { setStoredTenantSlug } from '../tenant';
import type { MeResponse } from '../api/types';

/**
 * The portal's auth/session layer — see docs/conventions/frontend-ess-mss.md
 * → "Auth + tenant context on the client". Deliberately thin: it owns
 * WHO the caller is (`GET /auth/me`'s `roles`/`permissions`/`branchIds`,
 * loaded fresh, never cached beyond this session — the same "read
 * permissions live, never trust a stale token" posture 0.4's own access
 * tokens already take server-side) and nothing about WHAT they can see —
 * every screen still asks `can(permission)` itself before rendering a
 * gated action, mirroring 0.4's "RBAC gates the feature" layer.
 */
export interface AuthContextValue {
  user: MeResponse | null;
  loading: boolean;
  login: (email: string, password: string, tenantSlug?: string) => Promise<void>;
  logout: () => Promise<void>;
  logoutAll: () => Promise<void>;
  can: (permission: string) => boolean;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<MeResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const refreshUser = useCallback(async () => {
    const me = await apiMe();
    setUser(me);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const ok = await bootstrapSession();
      if (cancelled) return;
      if (ok) {
        try {
          await refreshUser();
        } catch {
          clearTokens();
          setUser(null);
        }
      }
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshUser]);

  const login = useCallback(
    async (email: string, password: string, tenantSlug?: string) => {
      if (tenantSlug) setStoredTenantSlug(tenantSlug);
      const session = await apiLogin(email, password);
      setTokens(session.accessToken, session.refreshToken);
      await refreshUser();
    },
    [refreshUser],
  );

  const logout = useCallback(async () => {
    try {
      await apiLogout();
    } catch {
      // Best-effort — the token is being cleared client-side regardless.
    }
    clearTokens();
    setUser(null);
  }, []);

  const logoutAll = useCallback(async () => {
    try {
      await apiLogoutAll();
    } catch {
      // Best-effort — as above.
    }
    clearTokens();
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
