import type { Metadata } from 'next';
import { Inter, Noto_Kufi_Arabic } from 'next/font/google';
import { I18nProvider } from '../i18n/I18nProvider';
import { AuthProvider } from '../lib/auth/AuthContext';
import { BrandingProvider } from '../lib/branding/BrandingProvider';
import './globals.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });
const notoKufiArabic = Noto_Kufi_Arabic({ subsets: ['arabic'], variable: '--font-noto-kufi', display: 'swap' });

export const metadata: Metadata = {
  title: 'HRM Portal',
  description: 'Tenant organization portal',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // en/ltr is the safe default for the initial server render — I18nProvider
  // reconciles <html lang dir> client-side once a real per-tenant locale is
  // resolved (see its doc comment). Do not hardcode dir="ltr" elsewhere;
  // this is the one place it's set. Authenticated routes layer a SECOND,
  // session-aware <I18nProvider> on top with the resolved Country Pack's
  // real locale/rtl (see (app)/layout.tsx + lib/session/SessionProvider) —
  // this outer one only ever governs the (unauthenticated) /login screen.
  return (
    <html lang="en" dir="ltr" className={`${inter.variable} ${notoKufiArabic.variable}`}>
      <body>
        <AuthProvider>
          <BrandingProvider>
            <I18nProvider>{children}</I18nProvider>
          </BrandingProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
