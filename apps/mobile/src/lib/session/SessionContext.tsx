import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { getOwnEmployee } from '../api/employees';
import { getEffectiveCountryPack } from '../api/countryPacks';
import { useApplyResolvedLocale } from '../../i18n/I18nContext';
import type { SupportedLocale } from '../../i18n/messages';
import type { Employee, EffectiveCountryPackConfig } from '../api/types';

/**
 * Mirrors apps/portal/src/lib/session/SessionProvider.tsx — resolves the
 * caller's own Employee (`GET /employees/me`) and the EFFECTIVE Country
 * Pack for that employee's branch (`GET /country-packs/effective`) once
 * per session, feeding the AUTHORITATIVE `locale.rtl`/`locale.defaultLanguage`
 * into the i18n layer (see ../../i18n/I18nContext.tsx's `applyResolvedLocale`)
 * exactly like the portal feeds its `<I18nProvider>`. Gracefully degrades
 * to English/LTR defaults for a caller with no linked Employee record at
 * all (e.g. a TENANT_ADMIN-only account never onboarded as an employee) —
 * such a caller still gets a working app, just without employee-specific
 * ESS screens.
 */
export interface SessionContextValue {
  employee: Employee | null;
  employeeLoading: boolean;
  pack: EffectiveCountryPackConfig | null;
  ready: boolean;
  refreshEmployee: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

function toSupportedLocale(language: string | undefined): SupportedLocale {
  return language === 'ar' ? 'ar' : 'en';
}

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const applyResolvedLocale = useApplyResolvedLocale();
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

  useEffect(() => {
    if (packLoading) return;
    if (pack) {
      applyResolvedLocale(toSupportedLocale(pack.locale.defaultLanguage));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pack, packLoading]);

  const value = useMemo<SessionContextValue>(() => {
    const ready = !employeeLoading && !packLoading;
    return { employee, employeeLoading, pack, ready, refreshEmployee: loadEmployee };
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
