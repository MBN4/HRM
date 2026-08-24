import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'HRM Portal',
  description: 'Tenant organization portal',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
