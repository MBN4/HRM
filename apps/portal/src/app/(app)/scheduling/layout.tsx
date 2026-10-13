'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useMemo, useState } from 'react';
import { PERMISSIONS } from '@hrm/shared';
import { useI18n } from '../../../i18n/I18nProvider';
import { useAuth } from '../../../lib/auth/AuthContext';
import { useAsync } from '../../../lib/useAsync';
import { getSchedulingPeople } from '../../../lib/api/scheduling';
import { ymdInTimeZone } from '../../../lib/attendance-status';
import type { ViewMode } from '../../../lib/scheduling';
import { Alert } from '../../../components/ui/Alert';
import { SchedulingContext } from '../../../components/scheduling/SchedulingContext';

/**
 * Shift scheduling & rostering (step 8.2) — see docs/conventions/shift-scheduling.md. One layout for the four
 * sub-screens (roster / coverage / shifts / standing) so the visible window + team filter survive switching tabs.
 * Gated on `scheduling.manage`; the API enforces who may act on whom regardless.
 */
export default function SchedulingLayout({ children }: { children: React.ReactNode }) {
  const { t } = useI18n();
  const { can } = useAuth();
  const pathname = usePathname();
  const allowed = can(PERMISSIONS.SCHEDULING_MANAGE);

  const [anchor, setAnchor] = useState(() => ymdInTimeZone(new Date(), Intl.DateTimeFormat().resolvedOptions().timeZone));
  const [mode, setMode] = useState<ViewMode>('week');
  const [departmentId, setDepartmentId] = useState('');
  const { data: people, error } = useAsync(() => (allowed ? getSchedulingPeople() : Promise.resolve(null)), [allowed]);

  const value = useMemo(() => ({ people, anchor, setAnchor, mode, setMode, departmentId, setDepartmentId }), [people, anchor, mode, departmentId]);

  if (!allowed) return <Alert tone="info">{t('scheduling.noAccess')}</Alert>;

  const tabs = [
    { href: '/scheduling', label: t('scheduling.tab.roster'), id: 'roster' },
    { href: '/scheduling/coverage', label: t('scheduling.tab.coverage'), id: 'coverage' },
    { href: '/scheduling/shifts', label: t('scheduling.tab.shifts'), id: 'shifts' },
    { href: '/scheduling/standing', label: t('scheduling.tab.standing'), id: 'standing' },
  ];

  return (
    <SchedulingContext.Provider value={value}>
      <div className="space-y-5" data-testid="scheduling-page">
        <div>
          <h1 className="page-title">{t('scheduling.title')}</h1>
          <p className="page-subtitle">{t('scheduling.subtitle')}</p>
        </div>
        <nav aria-label={t('scheduling.tabs.label')} className="flex gap-1 overflow-x-auto border-b border-ink-100">
          {tabs.map((tab) => {
            const active = tab.href === '/scheduling' ? pathname === '/scheduling' : pathname.startsWith(tab.href);
            return (
              <Link
                key={tab.href}
                href={tab.href}
                data-testid={`scheduling-tab-${tab.id}`}
                aria-current={active ? 'page' : undefined}
                className={`relative -mb-px whitespace-nowrap rounded-t-lg px-4 py-2.5 text-sm font-medium transition-colors ${
                  active ? 'text-brand-700' : 'text-ink-500 hover:bg-sand-100 hover:text-ink-800'
                }`}
              >
                {tab.label}
                <span aria-hidden className={`absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-accent-500 ${active ? 'opacity-100' : 'opacity-0'}`} />
              </Link>
            );
          })}
        </nav>
        {error && <Alert tone="error">{error}</Alert>}
        {children}
      </div>
    </SchedulingContext.Provider>
  );
}
