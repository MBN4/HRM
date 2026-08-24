import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'HRM Admin Console',
  description: 'Vendor super-admin console',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
