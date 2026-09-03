'use client';

import { useRouter } from 'next/navigation';
import { ShieldCheck } from 'lucide-react';
import { usePlatformAuth } from '../../lib/auth/PlatformAuthContext';
import { Button } from '../ui/Button';
import { StatusBadge } from '../ui/Badge';

/**
 * The "who am I / am I MFA-verified" affordance this step's brief
 * explicitly calls out as crystal-clear-required — always visible, on
 * every authenticated screen. There is no way to be signed in to this
 * console WITHOUT MFA (see docs/conventions/vendor-console.md), so the
 * green shield is always accurate, never a state this UI has to guess at.
 */
export function Topbar() {
  const { me, logout } = usePlatformAuth();
  const router = useRouter();

  async function handleLogout() {
    await logout();
    router.replace('/login');
  }

  return (
    <header className="flex h-16 items-center justify-between border-b border-ink-100 bg-white px-6">
      <div />
      <div className="flex items-center gap-4">
        {me && (
          <>
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-brand-700">
              <ShieldCheck className="h-4 w-4" aria-hidden />
              MFA verified
            </span>
            <StatusBadge status={me.role} />
          </>
        )}
        <Button variant="secondary" size="sm" onClick={handleLogout} data-testid="sign-out-button">
          Sign out
        </Button>
      </div>
    </header>
  );
}
