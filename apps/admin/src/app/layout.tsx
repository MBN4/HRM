import type { Metadata } from 'next';
import { I18nProvider } from '../i18n/I18nProvider';

export const metadata: Metadata = {
  title: 'HRM Admin Console',
  description: 'Vendor super-admin console',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // en/ltr is the safe default for the initial server render — I18nProvider
  // reconciles <html lang dir> client-side once a real per-tenant locale is
  // resolved (see its doc comment). Do not hardcode dir="ltr" elsewhere;
  // this is the one place it's set.
  return (
    <html lang="en" dir="ltr">
      <body>
        <I18nProvider>{children}</I18nProvider>
      </body>
    </html>
  );
}
