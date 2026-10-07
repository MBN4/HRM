'use client';

import { Building2, CreditCard, FileClock, Globe2, LayoutDashboard, Paintbrush, ShieldAlert, ShieldCheck, Upload, UserCog } from 'lucide-react';
import { AppSidebar, type SidebarItem } from '@hrm/ui';
import { Wordmark } from '../brand/Wordmark';
import { usePlatformAuth } from '../../lib/auth/PlatformAuthContext';

// Same items, order and owner-only gating as before the 7.3 sidebar redesign —
// only the presentation moved to the shared packages/ui AppSidebar.
const NAV_ITEMS: (SidebarItem & { ownerOnly: boolean })[] = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, ownerOnly: false },
  { href: '/tenants', label: 'Tenants', icon: Building2, ownerOnly: false },
  { href: '/billing', label: 'Billing', icon: CreditCard, ownerOnly: false },
  { href: '/branding', label: 'Branding', icon: Paintbrush, ownerOnly: false },
  { href: '/country-packs', label: 'Country packs', icon: Globe2, ownerOnly: false },
  // Data migration & onboarding toolkit (step 3.5.1) — TENANT_MIGRATION_MANAGE
  // is held by BOTH platform roles, the same onboarding-support risk tier
  // IMPERSONATION_START already documents — see docs/conventions/data-migration.md.
  { href: '/migration', label: 'Data import', icon: Upload, ownerOnly: false },
  { href: '/impersonation', label: 'Impersonation', icon: ShieldAlert, ownerOnly: false },
  { href: '/audit', label: 'Audit trail', icon: FileClock, ownerOnly: false },
  // Data privacy & residency (step 6.1) — PRIVACY_READ is held by both
  // platform roles. See docs/conventions/privacy-residency.md.
  { href: '/privacy', label: 'Data privacy', icon: ShieldCheck, ownerOnly: false },
  { href: '/admins', label: 'Platform admins', icon: UserCog, ownerOnly: true },
];

export function Sidebar() {
  const { me } = usePlatformAuth();
  const items = NAV_ITEMS.filter((item) => !item.ownerOnly || me?.role === 'PLATFORM_OWNER');

  return (
    <AppSidebar
      variant="admin"
      groups={[{ id: 'platform', items }]}
      caption="Platform-wide · cross-tenant"
      labels={{
        primaryNav: 'Primary',
        collapse: 'Collapse sidebar',
        expand: 'Expand sidebar',
        resize: 'Resize sidebar',
        openMenu: 'Open navigation menu',
        closeMenu: 'Close navigation menu',
      }}
      brand={(compact) => <Wordmark tone="light" suffix="Vendor Console" markOnly={compact} />}
    />
  );
}
