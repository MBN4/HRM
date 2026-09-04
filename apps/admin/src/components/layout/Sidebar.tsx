'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Building2, CreditCard, FileClock, Globe2, LayoutDashboard, ShieldAlert, UserCog } from 'lucide-react';
import { usePlatformAuth } from '../../lib/auth/PlatformAuthContext';

const NAV_ITEMS = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, ownerOnly: false },
  { href: '/tenants', label: 'Tenants', icon: Building2, ownerOnly: false },
  { href: '/billing', label: 'Billing', icon: CreditCard, ownerOnly: false },
  { href: '/country-packs', label: 'Country packs', icon: Globe2, ownerOnly: false },
  { href: '/impersonation', label: 'Impersonation', icon: ShieldAlert, ownerOnly: false },
  { href: '/audit', label: 'Audit trail', icon: FileClock, ownerOnly: false },
  { href: '/admins', label: 'Platform admins', icon: UserCog, ownerOnly: true },
] as const;

export function Sidebar() {
  const pathname = usePathname();
  const { me } = usePlatformAuth();

  return (
    <aside className="flex h-screen w-60 shrink-0 flex-col border-e border-ink-800 bg-ink-900 text-ink-100">
      <div className="flex items-center gap-2 border-b border-ink-800 px-5 py-5">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-500 text-sm font-bold text-white">V</div>
        <div>
          <p className="text-sm font-semibold text-white">Vendor Console</p>
          <p className="text-xs text-ink-400">Platform-wide · cross-tenant</p>
        </div>
      </div>

      <nav className="flex-1 space-y-1 px-3 py-4">
        {NAV_ITEMS.filter((item) => !item.ownerOnly || me?.role === 'PLATFORM_OWNER').map((item) => {
          const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                active ? 'bg-brand-600 text-white' : 'text-ink-300 hover:bg-ink-800 hover:text-white'
              }`}
            >
              <Icon className="h-4 w-4" aria-hidden />
              {item.label}
            </Link>
          );
        })}
      </nav>

    </aside>
  );
}
