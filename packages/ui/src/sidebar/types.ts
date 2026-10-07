import type { ComponentType, ReactNode } from 'react';

export interface SidebarItem {
  href: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  /** Extra attributes (e.g. data-testid) forwarded to the link. */
  testId?: string;
}

export interface SidebarGroup {
  id: string;
  /** Section heading (hidden visually when collapsed — replaced by a divider). */
  label?: string;
  items: SidebarItem[];
}

/** Every user-visible string the sidebar chrome needs — the CALLER externalizes/translates these. */
export interface SidebarLabels {
  primaryNav: string;
  collapse: string;
  expand: string;
  resize: string;
  openMenu: string;
  closeMenu: string;
}

/** `portal`: soft pill + accent bar. `admin`: solid primary pill (the vendor console's darker identity). */
export type SidebarVariant = 'portal' | 'admin';

export interface AppSidebarProps {
  groups: SidebarGroup[];
  /** Pinned above the footer (e.g. Settings). */
  footerItems?: SidebarItem[];
  labels: SidebarLabels;
  variant?: SidebarVariant;
  /** The logo lockup; receives `compact` so it can show only the mark. */
  brand: (compact: boolean) => ReactNode;
  /** Optional extra content under the nav (e.g. an account chip). */
  footerSlot?: (compact: boolean) => ReactNode;
  /** A short caption under the brand (admin: "Platform-wide · cross-tenant"). */
  caption?: string;
}
