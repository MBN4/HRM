'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { usePlatformAuth } from '../../lib/auth/PlatformAuthContext';
import { Sidebar } from '../../components/layout/Sidebar';
import { Topbar } from '../../components/layout/Topbar';
import { PageSpinner } from '../../components/ui/Spinner';

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { me, loading } = usePlatformAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && !me) {
      router.replace('/login');
    }
  }, [loading, me, router]);

  if (loading || !me) {
    return <PageSpinner />;
  }

  return (
    <div className="flex min-h-screen bg-sand-50">
      <Sidebar />
      <div className="flex flex-1 flex-col">
        <Topbar />
        <main className="flex-1 overflow-y-auto p-6">{children}</main>
      </div>
    </div>
  );
}
