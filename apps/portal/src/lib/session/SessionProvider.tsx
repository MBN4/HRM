'use client';

import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { SupportedLocale } from '@hrm/shared';
import { useAuth } from '../auth/AuthContext';
import { getOwnEmployee } from '../api/employees';
import { getEffectiveCountryPack } from '../api/country-packs';
import type { Employee, EffectiveCountryPackConfig } from '../api/types';

/**
 * Resolves the two pieces of "who is this and where are they" every screen
 * needs, ONCE per session, and shares them down: the caller's own Employee
 * record (`GET /employees/me` — added this step, see
 * docs/conventions/frontend-ess-mss.md) and the EFFECTIVE Country Pack for
 * that employee's branch (`GET /country-packs/effective`). This is what
 * feeds the authoritative `locale.rtl`/`locale.defaultLanguage`/currency
 * signal into `<I18nProvider>` — the "future session-aware integration"
 * `I18nProvider.tsx`'s own doc comment names as the eventual real source of
 * truth, now wired for the first time.
 *
 * Gracefully degrades to `null`/defaults for a caller with no linked
 * Employee record at all (e.g. a TENANT_ADMIN-only account never onboarded
 * as an employee) — such a caller still gets a working (English/LTR)
 * portal, just without employee-specific ESS screens.
 */
export interface SessionContextValue {
  employee: Employee | null;
  employeeLoading: boolean;
  pack: EffectiveCountryPackConfig | null;
  locale: SupportedLocale;
  rtl: boolean;
  /** True once locale/rtl have reached their FINAL resolved value — `<I18nProvider>`'s `locale`/`rtl` props are read only on its initial mount, so callers should wait for this before mounting it (see (app)/layout.tsx). */
  ready: boolean;
  refreshEmployee: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

function toSupportedLocale(language: string | undefined): SupportedLocale {
  return language === 'ar' ? 'ar' : 'en';
}

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const [employee, setEmployee] = useState<Employee | null>(null);
  const [employeeLoading, setEmployeeLoading] = useState(true);
  const [pack, setPack] = useState<EffectiveCountryPackConfig | null>(null);
  const [packLoading, setPackLoading] = useState(true);

  async function loadEmployee() {
    setEmployeeLoading(true);
    try {
      const own = await getOwnEmployee();
      setEmployee(own);
    } catch {
      setEmployee(null);
    } finally {
      setEmployeeLoading(false);
    }
  }

  useEffect(() => {
    if (!user) {
      setEmployee(null);
      setPack(null);
      setEmployeeLoading(false);
      return;
    }
    loadEmployee();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.userId]);

  useEffect(() => {
    if (employeeLoading) return;
    if (!employee) {
      setPack(null);
      setPackLoading(false);
      return;
    }
    let cancelled = false;
    setPackLoading(true);
    getEffectiveCountryPack(employee.branchId)
      .then((config) => {
        if (!cancelled) setPack(config);
      })
      .catch(() => {
        if (!cancelled) setPack(null);
      })
      .finally(() => {
        if (!cancelled) setPackLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [employee, employeeLoading]);

  const value = useMemo<SessionContextValue>(() => {
    const locale = toSupportedLocale(pack?.locale.defaultLanguage);
    const rtl = pack?.locale.rtl ?? false;
    const ready = !employeeLoading && !packLoading;
    return { employee, employeeLoading, pack, locale, rtl, ready, refreshEmployee: loadEmployee };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employee, employeeLoading, pack, packLoading]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) {
    throw new Error('useSession() must be used within a <SessionProvider>.');
  }
  return ctx;
}
