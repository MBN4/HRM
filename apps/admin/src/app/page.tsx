'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { usePlatformAuth } from '../lib/auth/PlatformAuthContext';
import { PageSpinner } from '../components/ui/Spinner';

export default function RootPage() {
  const { me, loading } = usePlatformAuth();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;
    router.replace(me ? '/dashboard' : '/login');
  }, [loading, me, router]);

  return <PageSpinner />;
}
