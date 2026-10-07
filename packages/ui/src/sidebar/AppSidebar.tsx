'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChevronsLeft, ChevronsRight, Menu, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { RailTooltip } from './RailTooltip';
import {
  clampSidebarWidth,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_RAIL_WIDTH,
  useSidebar,
} from './SidebarProvider';
import type { AppSidebarProps, SidebarItem, SidebarVariant } from './types';

/** One easing for every sidebar motion — a soft "expo out" so it decelerates into place. Applied via `motion-safe:` classes ONLY, so prefers-reduced-motion gets no animation at all. */
const EASE_CLASS = 'motion-safe:ease-[cubic-bezier(0.22,1,0.36,1)]';
const KEY_STEP = 16;

/**
 * The shared app sidebar (portal + vendor console). See
 * docs/conventions/design-system.md § Sidebar.
 *
 * - Desktop (`lg`+): sticky rail. Collapses to an icons-only rail (tooltips on
 *   hover/focus), drag-resizable via a handle on the INNER edge, state persisted.
 * - Below `lg`: an overlay drawer (open via `SidebarMobileTrigger`), never a rail.
 * - RTL: every position/direction uses logical properties (`start`/`end`, `ms`/`me`)
 *   or an explicit `direction` check (the drag math), so it mirrors with `dir`.
 * - Motion: width/label transitions are CSS-only and disabled for
 *   `prefers-reduced-motion` and for the first paint after load.
 */
export function AppSidebar({ groups, footerItems = [], labels, variant = 'portal', brand, footerSlot, caption }: AppSidebarProps) {
  const pathname = usePathname();
  const { collapsed, width, ready, isDesktop, mobileOpen, setMobileOpen, toggleCollapsed, setCollapsed, setWidth } = useSidebar();
  const asideRef = useRef<HTMLElement>(null);

  // Live width while dragging (null = not dragging). Persisted only on release.
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const dragging = dragWidth !== null;

  const railNow = isDesktop && (dragging ? dragWidth < (SIDEBAR_RAIL_WIDTH + SIDEBAR_MIN_WIDTH) / 2 : collapsed);
  const compact = railNow; // labels hidden, icons only
  const renderedWidth = !isDesktop ? undefined : compact ? SIDEBAR_RAIL_WIDTH : dragging ? Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, dragWidth)) : width;

  // Close the drawer on navigation and on Escape.
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname, setMobileOpen]);
  useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMobileOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mobileOpen, setMobileOpen]);

  // ---- drag-to-resize ---------------------------------------------------
  // The sidebar is the first flex child, so in LTR it hugs the left edge and in
  // RTL the right. The handle sits on its END edge (the inner edge, toward the
  // content) in both. Pointer math reads the element's real `direction`.
  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!isDesktop || e.button !== 0) return;
      e.preventDefault();
      const aside = asideRef.current;
      if (!aside) return;
      const handle = e.currentTarget;
      handle.setPointerCapture(e.pointerId);
      const rtl = getComputedStyle(aside).direction === 'rtl';
      const rect = aside.getBoundingClientRect();
      const rawFor = (clientX: number) => (rtl ? rect.right - clientX : clientX - rect.left);
      let latest = rawFor(e.clientX);
      setDragWidth(latest);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';

      const onMove = (ev: PointerEvent) => {
        latest = rawFor(ev.clientX);
        setDragWidth(latest);
      };
      const onUp = () => {
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        handle.removeEventListener('pointercancel', onUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        // Below the midpoint between the rail and the minimum -> snap to the rail; else clamp.
        if (latest < (SIDEBAR_RAIL_WIDTH + SIDEBAR_MIN_WIDTH) / 2) {
          setCollapsed(true);
        } else {
          const next = clampSidebarWidth(latest);
          if (collapsed) setCollapsed(false);
          setWidth(next);
        }
        setDragWidth(null);
      };
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
      handle.addEventListener('pointercancel', onUp);
    },
    [isDesktop, collapsed, setCollapsed, setWidth],
  );

  const onHandleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const rtl = asideRef.current ? getComputedStyle(asideRef.current).direction === 'rtl' : false;
    const grow = rtl ? 'ArrowLeft' : 'ArrowRight';
    const shrink = rtl ? 'ArrowRight' : 'ArrowLeft';
    if (e.key === grow) {
      e.preventDefault();
      if (collapsed) setCollapsed(false);
      else setWidth(width + KEY_STEP);
    } else if (e.key === shrink) {
      e.preventDefault();
      if (!collapsed) {
        if (width - KEY_STEP < SIDEBAR_MIN_WIDTH) setCollapsed(true);
        else setWidth(width - KEY_STEP);
      }
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggleCollapsed();
    }
  };

  const animate = ready && !dragging; // no animation on first paint or while dragging
  const motion = animate ? `motion-safe:transition-[width] motion-safe:duration-[260ms] ${EASE_CLASS}` : '';

  return (
    <>
      {/* Drawer backdrop (small screens only). */}
      <div
        aria-hidden="true"
        onClick={() => setMobileOpen(false)}
        data-testid="sidebar-backdrop"
        className={`fixed inset-0 z-30 bg-ink-900/50 backdrop-blur-[2px] transition-opacity duration-200 motion-reduce:transition-none lg:hidden ${
          mobileOpen ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
      />
      <aside
        ref={asideRef}
        data-testid="app-sidebar"
        data-collapsed={compact ? 'true' : 'false'}
        data-ready={ready ? 'true' : 'false'}
        data-dragging={dragging ? 'true' : 'false'}
        style={{ width: renderedWidth }}
        className={`group/sb z-40 flex shrink-0 flex-col bg-sidebar text-sidebar-fg max-lg:fixed max-lg:inset-y-0 max-lg:start-0 max-lg:w-[17rem] max-lg:max-w-[85vw] max-lg:shadow-pop max-lg:transition-[transform,visibility] max-lg:duration-300 motion-reduce:max-lg:transition-none lg:sticky lg:top-0 lg:h-screen ${motion} ${
          mobileOpen ? '' : 'max-lg:invisible max-lg:-translate-x-full max-lg:rtl:translate-x-full'
        }`}
      >
        {/* Brand */}
        <div className="flex h-16 shrink-0 items-center justify-between gap-2 px-4">
          <div className={`min-w-0 overflow-hidden ${compact ? 'mx-auto' : ''}`}>{brand(compact)}</div>
          <button
            type="button"
            onClick={() => setMobileOpen(false)}
            aria-label={labels.closeMenu}
            className="rounded-lg p-2 text-sidebar-fg hover:bg-white/[0.08] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-400 lg:hidden"
          >
            <X className="h-5 w-5" aria-hidden />
          </button>
        </div>
        {caption && !compact && <p className="eyebrow truncate px-5 pb-1 text-sidebar-fg/80">{caption}</p>}

        {/* Nav */}
        <nav aria-label={labels.primaryNav} className="flex-1 overflow-y-auto overflow-x-hidden px-3 py-3 scrollbar-thin">
          {groups.map((group, index) => (
            <div key={group.id} className={index === 0 ? '' : 'mt-5'}>
              {group.label &&
                (compact ? (
                  index > 0 && <div className="mx-3 mb-3 border-t border-white/10" aria-hidden />
                ) : (
                  <p className="eyebrow truncate px-3 pb-2 text-sidebar-fg/80">{group.label}</p>
                ))}
              <ul className="space-y-0.5">
                {group.items.map((item) => (
                  <NavLink key={item.href} item={item} pathname={pathname} compact={compact} animate={animate} variant={variant} />
                ))}
              </ul>
            </div>
          ))}
        </nav>

        {/* Footer: pinned items, account slot, collapse toggle */}
        <div className="shrink-0 space-y-1 border-t border-white/10 p-3">
          {footerItems.length > 0 && (
            <ul className="space-y-0.5">
              {footerItems.map((item) => (
                <NavLink key={item.href} item={item} pathname={pathname} compact={compact} animate={animate} variant={variant} />
              ))}
            </ul>
          )}
          {footerSlot?.(compact)}
          <RailTooltip label={compact ? labels.expand : labels.collapse} enabled={compact}>
            {(trigger) => (
              <button
                type="button"
                {...trigger}
                ref={trigger.ref as React.Ref<HTMLButtonElement>}
                onClick={toggleCollapsed}
                aria-label={compact ? labels.expand : labels.collapse}
                aria-expanded={!compact}
                data-testid="sidebar-toggle"
                className="hidden w-full items-center rounded-lg px-3 py-2 text-sm font-medium text-sidebar-fg/90 transition-colors hover:bg-white/[0.07] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-400 lg:flex"
              >
                <span className="flex h-6 w-6 shrink-0 items-center justify-center">
                  {/* Chevrons point the way the sidebar will move: toward the inline-start edge to collapse. */}
                  {compact ? (
                    <ChevronsRight className="h-5 w-5 rtl:rotate-180" aria-hidden />
                  ) : (
                    <ChevronsLeft className="h-5 w-5 rtl:rotate-180" aria-hidden />
                  )}
                </span>
                <Label compact={compact} animate={animate}>
                  {labels.collapse}
                </Label>
              </button>
            )}
          </RailTooltip>
        </div>

        {/* Resize handle — on the inner (inline-end) edge. Desktop only. */}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={labels.resize}
          aria-valuemin={SIDEBAR_RAIL_WIDTH}
          aria-valuemax={SIDEBAR_MAX_WIDTH}
          aria-valuenow={Math.round(compact ? SIDEBAR_RAIL_WIDTH : (renderedWidth ?? width))}
          tabIndex={0}
          data-testid="sidebar-resize-handle"
          onPointerDown={onPointerDown}
          onKeyDown={onHandleKeyDown}
          onDoubleClick={toggleCollapsed}
          className="group/handle absolute inset-y-0 -end-1.5 z-10 hidden w-3 cursor-col-resize touch-none select-none focus-visible:outline-none lg:block"
        >
          <span
            aria-hidden
            className={`absolute inset-y-0 start-1/2 w-0.5 -translate-x-1/2 rounded-full bg-accent-400/0 transition-colors duration-150 group-hover/handle:bg-accent-400/70 group-focus-visible/handle:bg-accent-400 rtl:translate-x-1/2 ${
              dragging ? '!bg-accent-400' : ''
            }`}
          />
        </div>
      </aside>
    </>
  );
}

/** Hamburger shown in the Topbar below `lg` to open the drawer. */
export function SidebarMobileTrigger({ label }: { label: string }) {
  const { setMobileOpen, mobileOpen } = useSidebar();
  return (
    <button
      type="button"
      onClick={() => setMobileOpen(true)}
      aria-label={label}
      aria-expanded={mobileOpen}
      data-testid="sidebar-mobile-trigger"
      className="rounded-lg p-2 text-ink-600 hover:bg-sand-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 lg:hidden"
    >
      <Menu className="h-5 w-5" aria-hidden />
    </button>
  );
}

function Label({ compact, animate, children }: { compact: boolean; animate: boolean; children: React.ReactNode }) {
  return (
    <span
      className={`block truncate whitespace-nowrap ${animate ? `motion-safe:transition-[opacity,max-width,margin] motion-safe:duration-[220ms] ${EASE_CLASS}` : ''} ${
        compact ? 'ms-0 max-w-0 opacity-0' : 'ms-3 max-w-[16rem] opacity-100'
      }`}
    >
      {children}
    </span>
  );
}

function NavLink({
  item,
  pathname,
  compact,
  animate,
  variant,
}: {
  item: SidebarItem;
  pathname: string | null;
  compact: boolean;
  animate: boolean;
  variant: SidebarVariant;
}) {
  const active = pathname === item.href || !!pathname?.startsWith(`${item.href}/`);
  const Icon = item.icon;
  const activeClass =
    variant === 'admin' ? 'bg-primary text-white shadow-card' : 'bg-white/[0.12] text-white';
  return (
    <li>
      <RailTooltip label={item.label} enabled={compact}>
        {(trigger) => (
          <Link
            href={item.href}
            {...trigger}
            ref={trigger.ref as React.Ref<HTMLAnchorElement>}
            aria-current={active ? 'page' : undefined}
            data-testid={item.testId ?? `nav-${item.href}`}
            data-active={active ? 'true' : 'false'}
            className={`group/item relative flex items-center rounded-lg px-3 py-2 text-sm font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-400 ${
              active ? activeClass : 'text-sidebar-fg hover:bg-white/[0.07] hover:text-white'
            }`}
          >
            {active && variant === 'portal' && (
              <span className="absolute inset-y-1.5 start-0 w-1 rounded-full bg-accent-400" aria-hidden />
            )}
            <span className="flex h-6 w-6 shrink-0 items-center justify-center" aria-hidden>
              <Icon
                className={`h-[1.15rem] w-[1.15rem] transition-transform duration-150 group-hover/item:scale-110 motion-reduce:transform-none ${
                  active ? (variant === 'admin' ? '' : 'text-accent-300') : 'text-sidebar-fg/80 group-hover/item:text-accent-300'
                }`}
              />
            </span>
            <Label compact={compact} animate={animate}>
              {item.label}
            </Label>
          </Link>
        )}
      </RailTooltip>
    </li>
  );
}
