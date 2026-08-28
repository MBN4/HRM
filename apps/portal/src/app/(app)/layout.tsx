'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '../../lib/auth/AuthContext';
import { SessionProvider, useSession } from '../../lib/session/SessionProvider';
import { I18nProvider } from '../../i18n/I18nProvider';
import { Sidebar } from '../../components/layout/Sidebar';
import { Topbar } from '../../components/layout/Topbar';
import { PageSpinner } from '../../components/ui/Spinner';

/**
 * The authenticated shell — gates every route under it on a resolved
 * session, then layers a SECOND, session-aware `<I18nProvider>` on top of
 * the root layout's default one, fed the AUTHORITATIVE locale/rtl signal
 * (the resolved Country Pack for the caller's own branch, via
 * `useSession()`) instead of the bare language-code guess the outer
 * provider uses for the (unauthenticated) login screen — see
 * docs/conventions/frontend-ess-mss.md.
 *
 * Auth is bearer-JWT, held client-side (no session cookie) — there is no
 * server-renderable "logged in" signal for Next middleware to gate on, so
 * this is a deliberate client-side redirect gate instead, the standard
 * shape for a token-based (non-cookie) SPA-style auth flow layered onto
 * the App Router.
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthGate>
      <SessionProvider>
        <ResolvedI18n>
          <div className="flex min-h-screen bg-sand-50">
            <Sidebar />
            <div className="flex min-w-0 flex-1 flex-col">
              <Topbar />
              <main className="flex-1 overflow-y-auto p-6">{children}</main>
            </div>
          </div>
        </ResolvedI18n>
      </SessionProvider>
    </AuthGate>
  );
}

function AuthGate({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && !user) {
      router.replace('/login');
    }
  }, [loading, user, router]);

  if (loading || !user) {
    return <PageSpinner />;
  }
  return <>{children}</>;
}

function ResolvedI18n({ children }: { children: React.ReactNode }) {
  const { locale, rtl, ready } = useSession();
  // `<I18nProvider>` only reads its `locale`/`rtl` props on its INITIAL
  // mount (see its own doc comment) — so this waits for the Country Pack
  // resolution to settle before mounting it, rather than mounting early
  // with a default that a later prop change couldn't correct anyway.
  if (!ready) {
    return <PageSpinner />;
  }
  return (
    <I18nProvider locale={locale} rtl={rtl}>
      {children}
    </I18nProvider>
  );
}
