'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  BarChart3,
  Bell,
  Briefcase,
  CalendarClock,
  CalendarDays,
  ClipboardCheck,
  LayoutDashboard,
  Megaphone,
  Network,
  Settings,
  Target,
  User,
  UserMinus,
  UserPlus,
  Users,
  Wallet,
} from 'lucide-react';
import { useI18n } from '../../i18n/I18nProvider';
import { useAuth } from '../../lib/auth/AuthContext';
import { PERMISSIONS } from '@hrm/shared';

interface NavItem {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
}

export function Sidebar() {
  const { t } = useI18n();
  const { can } = useAuth();
  const pathname = usePathname();

  const essItems: NavItem[] = [
    { href: '/dashboard', label: t('nav.dashboard'), icon: LayoutDashboard },
    { href: '/profile', label: t('nav.profile'), icon: User },
    { href: '/leave', label: t('nav.leave'), icon: CalendarDays },
    { href: '/attendance', label: t('nav.attendance'), icon: CalendarClock },
    { href: '/notifications', label: t('nav.notifications'), icon: Bell },
    { href: '/announcements', label: t('nav.announcements'), icon: Megaphone },
  ];

  const mssItems: NavItem[] = [{ href: '/approvals', label: t('nav.approvals'), icon: ClipboardCheck }];
  if (can(PERMISSIONS.ATTENDANCE_APPROVE) || can(PERMISSIONS.LEAVE_APPROVE)) {
    mssItems.push({ href: '/team', label: t('nav.team'), icon: Users });
  }
  mssItems.push({ href: '/org-chart', label: t('nav.orgChart'), icon: Network });
  if (can(PERMISSIONS.ANALYTICS_READ)) {
    mssItems.push({ href: '/analytics', label: t('nav.analytics'), icon: BarChart3 });
  }

  // Admin console — one entry per module, each gated on its own
  // permission(s). Later stages append their own `if (can(...)) push(...)`
  // lines here (Performance/Recruitment/Onboarding/Offboarding); this
  // array renders as a third nav section only when non-empty.
  const adminItems: NavItem[] = [];
  if (can(PERMISSIONS.PAYROLL_RUN) || can(PERMISSIONS.PAYROLL_APPROVE)) {
    adminItems.push({ href: '/payroll', label: t('nav.payroll'), icon: Wallet });
  }
  if (can(PERMISSIONS.PERFORMANCE_READ) || can(PERMISSIONS.PERFORMANCE_MANAGE)) {
    adminItems.push({ href: '/performance', label: t('nav.performance'), icon: Target });
  }
  if (can(PERMISSIONS.RECRUITMENT_READ) || can(PERMISSIONS.RECRUITMENT_MANAGE)) {
    adminItems.push({ href: '/recruitment', label: t('nav.recruitment'), icon: Briefcase });
  }
  if (can(PERMISSIONS.ONBOARDING_MANAGE)) {
    adminItems.push({ href: '/recruitment/onboarding', label: t('nav.onboarding'), icon: UserPlus });
  }
  if (can(PERMISSIONS.OFFBOARDING_MANAGE)) {
    adminItems.push({ href: '/recruitment/offboarding', label: t('nav.offboarding'), icon: UserMinus });
  }

  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-e border-ink-100 bg-white">
      <div className="flex h-16 items-center gap-2 px-5">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-600 text-sm font-bold text-white">H</div>
        <span className="text-base font-semibold text-ink-900">{t('app.name')}</span>
      </div>
      <nav className="flex-1 space-y-6 overflow-y-auto px-3 py-4 scrollbar-thin">
        <NavGroup items={essItems} pathname={pathname} />
        <div>
          <p className="px-3 pb-2 text-xs font-semibold uppercase tracking-wide text-ink-400">{t('nav.team')}</p>
          <NavGroup items={mssItems} pathname={pathname} />
        </div>
        {adminItems.length > 0 && (
          <div>
            <p className="px-3 pb-2 text-xs font-semibold uppercase tracking-wide text-ink-400">{t('nav.admin')}</p>
            <NavGroup items={adminItems} pathname={pathname} />
          </div>
        )}
      </nav>
      <div className="border-t border-ink-100 p-3">
        <NavGroup items={[{ href: '/settings', label: t('nav.settings'), icon: Settings }]} pathname={pathname} />
      </div>
    </aside>
  );
}

function NavGroup({ items, pathname }: { items: NavItem[]; pathname: string | null }) {
  return (
    <ul className="space-y-0.5">
      {items.map((item) => {
        const active = pathname === item.href || pathname?.startsWith(`${item.href}/`);
        const Icon = item.icon;
        return (
          <li key={item.href}>
            <Link
              href={item.href}
              className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                active ? 'bg-brand-50 text-brand-800' : 'text-ink-600 hover:bg-sand-100 hover:text-ink-900'
              }`}
            >
              <Icon className="h-4 w-4 shrink-0" aria-hidden />
              {item.label}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
