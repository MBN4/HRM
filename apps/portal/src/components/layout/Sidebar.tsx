'use client';

import {
  BarChart3,
  Bell,
  Boxes,
  Briefcase,
  CalendarClock,
  CalendarDays,
  ClipboardCheck,
  CreditCard,
  FileSignature,
  FileText,
  GraduationCap,
  HeartPulse,
  LayoutDashboard,
  LifeBuoy,
  Megaphone,
  GitFork,
  Network,
  Paintbrush,
  Receipt,
  Settings,
  ShieldCheck,
  Target,
  Clock3,
  Upload,
  User,
  UserCog,
  UserMinus,
  UserPlus,
  Users,
  Wallet,
} from 'lucide-react';
import { useI18n } from '../../i18n/I18nProvider';
import { useAuth } from '../../lib/auth/AuthContext';
import { useBranding } from '../../lib/branding/BrandingProvider';
import { PERMISSIONS } from '@hrm/shared';
import { AppSidebar, type SidebarGroup, type SidebarItem } from '@hrm/ui';
import { Wordmark } from '../brand/Wordmark';

type NavItem = SidebarItem;

export function Sidebar() {
  const { t } = useI18n();
  const { can } = useAuth();
  const { branding, logoUrl } = useBranding();

  const essItems: NavItem[] = [
    { href: '/dashboard', label: t('nav.dashboard'), icon: LayoutDashboard },
    { href: '/profile', label: t('nav.profile'), icon: User },
    { href: '/leave', label: t('nav.leave'), icon: CalendarDays },
    { href: '/attendance', label: t('nav.attendance'), icon: CalendarClock },
    { href: '/expenses', label: t('nav.expenses'), icon: Receipt },
    { href: '/benefits', label: t('nav.benefits'), icon: HeartPulse },
    { href: '/assets', label: t('nav.assets'), icon: Boxes },
    { href: '/helpdesk', label: t('nav.helpdesk'), icon: LifeBuoy },
    { href: '/learning', label: t('nav.learning'), icon: GraduationCap },
    { href: '/notifications', label: t('nav.notifications'), icon: Bell },
    { href: '/announcements', label: t('nav.announcements'), icon: Megaphone },
    { href: '/esignature/my', label: t('nav.myEsignatures'), icon: FileSignature },
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
  // Operations modules (step 3.1) — see docs/conventions/operations-modules.md.
  if (can(PERMISSIONS.EXPENSE_MANAGE)) {
    adminItems.push({ href: '/expenses/admin', label: t('nav.expenses'), icon: Receipt });
  }
  if (can(PERMISSIONS.ASSET_MANAGE)) {
    adminItems.push({ href: '/assets/admin', label: t('nav.assets'), icon: Boxes });
  }
  if (can(PERMISSIONS.HELPDESK_MANAGE)) {
    adminItems.push({ href: '/helpdesk/admin', label: t('nav.helpdesk'), icon: LifeBuoy });
  }
  if (can(PERMISSIONS.ANNOUNCEMENT_MANAGE) || can(PERMISSIONS.POLICY_MANAGE)) {
    adminItems.push({ href: '/announcements/admin', label: t('nav.announcementsAdmin'), icon: Megaphone });
  }
  // Learning & Development (step 3.2) — see docs/conventions/lms.md.
  if (can(PERMISSIONS.LMS_AUTHOR) || can(PERMISSIONS.LMS_MANAGE)) {
    adminItems.push({ href: '/learning/admin', label: t('nav.learningAdmin'), icon: GraduationCap });
  }
  // Billing (step 4.2) — see docs/conventions/billing.md.
  if (can(PERMISSIONS.BILLING_MANAGE)) {
    adminItems.push({ href: '/billing', label: t('nav.billing'), icon: CreditCard });
  }
  // White-label / branding (step 4.3) — see docs/conventions/white-label.md.
  if (can(PERMISSIONS.BRANDING_MANAGE)) {
    adminItems.push({ href: '/branding', label: t('nav.branding'), icon: Paintbrush });
  }
  // Data migration & onboarding toolkit (step 3.5.1) — see
  // docs/conventions/data-migration.md.
  if (can(PERMISSIONS.MIGRATION_MANAGE)) {
    adminItems.push({ href: '/migration', label: t('nav.migration'), icon: Upload });
  }
  // Benefits administration (step 3.5.2) — see docs/conventions/benefits.md.
  if (can(PERMISSIONS.BENEFITS_MANAGE)) {
    adminItems.push({ href: '/benefits/admin', label: t('nav.benefitsAdmin'), icon: HeartPulse });
  }
  // E-signatures (step 3.5.3) — see docs/conventions/e-signatures.md.
  if (can(PERMISSIONS.ESIGNATURE_REQUEST) || can(PERMISSIONS.ESIGNATURE_MANAGE)) {
    adminItems.push({ href: '/esignature', label: t('nav.esignature'), icon: FileSignature });
  }
  // Statutory / government reporting (step 3.5.4) — see docs/conventions/statutory-reporting.md.
  if (can(PERMISSIONS.STATUTORY_REPORT_READ) || can(PERMISSIONS.STATUTORY_REPORT_GENERATE)) {
    adminItems.push({ href: '/statutory-reports', label: t('nav.statutoryReports'), icon: FileText });
  }
  // Tenant user / team access management (step 7.1) — see docs/conventions/user-management.md.
  if (can(PERMISSIONS.USER_MANAGE)) {
    adminItems.push({ href: '/users', label: t('nav.users'), icon: UserCog });
    // Step 7.2 — hierarchical approvals: the reporting tree (NOT the employee /org-chart).
    adminItems.push({ href: '/hierarchy', label: t('nav.hierarchy'), icon: GitFork });
  }
  // Working hours (step 8.1) — see docs/conventions/.
  if (can(PERMISSIONS.WORKING_HOURS_MANAGE)) {
    adminItems.push({ href: '/working-hours', label: t('nav.workingHours'), icon: Clock3 });
  }
  // Data privacy & residency (step 6.1) — see docs/conventions/privacy-residency.md.
  if (can(PERMISSIONS.PRIVACY_MANAGE)) {
    adminItems.push({ href: '/privacy', label: t('nav.privacy'), icon: ShieldCheck });
  }

  // Presentation only (packages/ui's AppSidebar) — the items, their order and
  // their permission gates above are untouched.
  const groups: SidebarGroup[] = [
    { id: 'ess', items: essItems },
    { id: 'team', label: t('nav.team'), items: mssItems },
  ];
  if (adminItems.length > 0) groups.push({ id: 'admin', label: t('nav.admin'), items: adminItems });

  return (
    <AppSidebar
      variant="portal"
      groups={groups}
      footerItems={[{ href: '/settings', label: t('nav.settings'), icon: Settings }]}
      labels={{
        primaryNav: t('sidebar.primaryNav'),
        collapse: t('sidebar.collapse'),
        expand: t('sidebar.expand'),
        resize: t('sidebar.resize'),
        openMenu: t('sidebar.openMenu'),
        closeMenu: t('sidebar.closeMenu'),
      }}
      brand={(compact) => <Wordmark name={branding.productName} logoUrl={logoUrl} tone="light" tint={branding.primaryColor} markOnly={compact} />}
    />
  );
}
