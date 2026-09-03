import type { Metadata } from 'next';
import { I18nProvider } from '../i18n/I18nProvider';
import { PlatformAuthProvider } from '../lib/auth/PlatformAuthContext';
import './globals.css';

export const metadata: Metadata = {
  title: 'HRM Vendor Console',
  description: 'Vendor super-admin console — platform-wide, cross-tenant operations',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // en/ltr is the safe default for the initial server render — I18nProvider
  // reconciles <html lang dir> client-side, same convention apps/portal's
  // RootLayout documents for itself. This console is internal tooling for
  // vendor operations staff — "functional over fancy" extends to scope
  // here too: it does not attempt session-aware i18n/RTL the way the
  // tenant-facing portal does (no per-tenant locale exists to resolve),
  // only the same locale-toggle proof-of-concept 0.9 already wired up.
  return (
    <html lang="en" dir="ltr">
      <body>
        <PlatformAuthProvider>
          <I18nProvider>{children}</I18nProvider>
        </PlatformAuthProvider>
      </body>
    </html>
  );
}
