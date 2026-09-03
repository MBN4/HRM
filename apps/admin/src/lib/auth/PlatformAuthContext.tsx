'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  platformConfirmMfaEnrollment,
  platformLogin,
  platformLogout,
  platformMe,
  platformStartMfaEnrollment,
  platformVerifyMfa,
} from '../api/auth';
import { clearTokens, getRefreshToken, setTokens } from './token-storage';
import type { PlatformEnrollmentSecret, PlatformLoginStepResult, PlatformMe } from '../api/types';

/**
 * The admin console's session layer — deliberately a LARGER state machine
 * than apps/portal's `AuthContext` (which is a single `login()` call):
 * platform login is password THEN mandatory MFA (either verify an
 * already-enrolled admin, or complete first-time enrollment) — see
 * docs/conventions/vendor-console.md → Mandatory MFA. Nothing here ever
 * reaches a real session (`me` populated) without both factors having
 * succeeded, mirroring the backend's own "no code path issues a token from
 * a password alone" guarantee.
 */
export interface PlatformAuthContextValue {
  me: PlatformMe | null;
  loading: boolean;
  loginWithPassword: (email: string, password: string) => Promise<PlatformLoginStepResult>;
  startMfaEnrollment: (enrollmentToken: string) => Promise<PlatformEnrollmentSecret>;
  confirmMfaEnrollment: (enrollmentToken: string, code: string) => Promise<{ recoveryCodes: string[] }>;
  verifyMfa: (challengeToken: string, code: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshMe: () => Promise<void>;
}

const PlatformAuthContext = createContext<PlatformAuthContextValue | null>(null);

export function PlatformAuthProvider({ children }: { children: React.ReactNode }) {
  const [me, setMe] = useState<PlatformMe | null>(null);
  const [loading, setLoading] = useState(true);

  const refreshMe = useCallback(async () => {
    const result = await platformMe();
    setMe(result);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (getRefreshToken()) {
        try {
          await refreshMe();
        } catch {
          clearTokens();
          if (!cancelled) setMe(null);
        }
      }
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshMe]);

  const loginWithPassword = useCallback((email: string, password: string) => platformLogin(email, password), []);

  const startMfaEnrollment = useCallback((enrollmentToken: string) => platformStartMfaEnrollment(enrollmentToken), []);

  const confirmMfaEnrollment = useCallback(
    async (enrollmentToken: string, code: string) => {
      const session = await platformConfirmMfaEnrollment(enrollmentToken, code);
      setTokens(session.accessToken, session.refreshToken);
      setMe({ platformAdminId: session.platformAdminId, role: session.role });
      return { recoveryCodes: session.recoveryCodes };
    },
    [],
  );

  const verifyMfa = useCallback(async (challengeToken: string, code: string) => {
    const session = await platformVerifyMfa(challengeToken, code);
    setTokens(session.accessToken, session.refreshToken);
    setMe({ platformAdminId: session.platformAdminId, role: session.role });
  }, []);

  const logout = useCallback(async () => {
    const refreshToken = getRefreshToken();
    try {
      if (refreshToken) await platformLogout(refreshToken);
    } catch {
      // Best-effort — the token is being cleared client-side regardless.
    }
    clearTokens();
    setMe(null);
  }, []);

  const value = useMemo<PlatformAuthContextValue>(
    () => ({ me, loading, loginWithPassword, startMfaEnrollment, confirmMfaEnrollment, verifyMfa, logout, refreshMe }),
    [me, loading, loginWithPassword, startMfaEnrollment, confirmMfaEnrollment, verifyMfa, logout, refreshMe],
  );

  return <PlatformAuthContext.Provider value={value}>{children}</PlatformAuthContext.Provider>;
}

export function usePlatformAuth(): PlatformAuthContextValue {
  const ctx = useContext(PlatformAuthContext);
  if (!ctx) {
    throw new Error('usePlatformAuth() must be used within a <PlatformAuthProvider>.');
  }
  return ctx;
}
