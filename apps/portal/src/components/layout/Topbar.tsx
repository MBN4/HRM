'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Bell, ChevronDown, LogOut } from 'lucide-react';
import { useI18n } from '../../i18n/I18nProvider';
import { useAuth } from '../../lib/auth/AuthContext';
import { useSession } from '../../lib/session/SessionProvider';
import { useAsync } from '../../lib/useAsync';
import { listNotifications } from '../../lib/api/notifications';

export function Topbar() {
  const { t, locale, setLocale } = useI18n();
  const { logout, user } = useAuth();
  const { employee } = useSession();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // The user menu is a custom (non-<select>) dropdown — Escape must close
  // it (WCAG 2.1.2, no keyboard trap) and it must close on outside click
  // too, or it stays open over unrelated page content indefinitely.
  useEffect(() => {
    if (!menuOpen) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setMenuOpen(false);
    }
    function onClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    }
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('mousedown', onClickOutside);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('mousedown', onClickOutside);
    };
  }, [menuOpen]);

  const { data: notifications } = useAsync(() => listNotifications(), []);
  const unreadCount = notifications?.filter((n) => !n.delivery.readAt).length ?? 0;

  const displayName = employee ? `${employee.firstName} ${employee.lastName}` : (user?.userId ?? '');

  return (
    <header className="flex h-16 items-center justify-between gap-4 border-b border-ink-100 bg-white px-6">
      <div />
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => setLocale(locale === 'en' ? 'ar' : 'en')}
          className="rounded-lg border border-ink-200 px-2.5 py-1.5 text-xs font-semibold text-ink-600 hover:bg-sand-100"
          aria-label={t('settings.language')}
        >
          {locale === 'en' ? 'العربية' : 'English'}
        </button>

        <Link
          href="/notifications"
          className="relative rounded-lg p-2 text-ink-500 hover:bg-sand-100 hover:text-ink-800"
          aria-label={unreadCount > 0 ? `${t('nav.notifications')} (${unreadCount} unread)` : t('nav.notifications')}
        >
          <Bell className="h-5 w-5" aria-hidden />
          {unreadCount > 0 && (
            <span className="absolute end-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-coral-500 px-1 text-[10px] font-bold text-white">
              {unreadCount}
            </span>
          )}
        </Link>

        <div className="relative" ref={menuRef}>
          <button
            type="button"
            data-testid="user-menu-button"
            onClick={() => setMenuOpen((v) => !v)}
            aria-expanded={menuOpen}
            className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm font-medium text-ink-700 hover:bg-sand-100"
          >
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-brand-100 text-xs font-semibold text-brand-800">
              {displayName.slice(0, 1).toUpperCase()}
            </span>
            <span className="hidden sm:inline">{displayName}</span>
            <ChevronDown className="h-3.5 w-3.5 text-ink-400" aria-hidden />
          </button>
          {menuOpen && (
            <div className="absolute end-0 z-10 mt-2 w-48 rounded-lg border border-ink-100 bg-white py-1 shadow-soft">
              <Link href="/settings" onClick={() => setMenuOpen(false)} className="block px-4 py-2 text-sm text-ink-700 hover:bg-sand-100">
                {t('nav.settings')}
              </Link>
              <button
                type="button"
                data-testid="sign-out-button"
                onClick={() => {
                  setMenuOpen(false);
                  void logout();
                }}
                className="flex w-full items-center gap-2 px-4 py-2 text-start text-sm text-coral-600 hover:bg-sand-100"
              >
                <LogOut className="h-3.5 w-3.5" aria-hidden />
                {t('nav.signOut')}
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
