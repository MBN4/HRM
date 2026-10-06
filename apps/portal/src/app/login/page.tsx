'use client';

import { FormEvent, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useI18n } from '../../i18n/I18nProvider';
import { useAuth } from '../../lib/auth/AuthContext';
import { useBranding } from '../../lib/branding/BrandingProvider';
import { getStoredTenantSlug, isUsingSubdomainResolution } from '../../lib/tenant';
import { ApiError } from '../../lib/api/client';
import { Button } from '../../components/ui/Button';
import { Input, Label } from '../../components/ui/Field';
import { PasswordInput } from '../../components/ui/PasswordInput';
import { Alert } from '../../components/ui/Alert';
import { Wordmark } from '../../components/brand/Wordmark';
import { PoweredByFooter } from '../../components/layout/PoweredByFooter';

export default function LoginPage() {
  const { t } = useI18n();
  const { login, user, loading: sessionLoading } = useAuth();
  const { branding, logoUrl } = useBranding();
  const router = useRouter();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [tenantSlug, setTenantSlug] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showWorkspaceField, setShowWorkspaceField] = useState(false);

  useEffect(() => {
    setShowWorkspaceField(!isUsingSubdomainResolution());
    setTenantSlug(getStoredTenantSlug() ?? '');
  }, []);

  useEffect(() => {
    if (!sessionLoading && user) {
      router.replace('/dashboard');
    }
  }, [sessionLoading, user, router]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(email, password, showWorkspaceField ? tenantSlug : undefined);
      router.replace('/dashboard');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('error.generic'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="auth-backdrop flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-8 flex justify-center">
          <Wordmark name={branding.productName} logoUrl={logoUrl} tint={branding.primaryColor} tone="light" size="lg" />
        </div>
        <div className="auth-card">
          <h1 className="text-xl font-semibold tracking-tight text-ink-900">{branding.loginHeadline || t('auth.login.title')}</h1>
          <p className="mt-1 text-sm text-ink-500">{branding.loginSubtext || t('auth.login.subtitle')}</p>

          <form onSubmit={handleSubmit} className="mt-6 space-y-4">
            {showWorkspaceField && (
              <div>
                <Label htmlFor="tenantSlug">{t('auth.login.workspace')}</Label>
                <Input
                  id="tenantSlug"
                  value={tenantSlug}
                  onChange={(e) => setTenantSlug(e.target.value)}
                  placeholder="acme"
                  required
                  autoComplete="organization"
                />
                <p className="mt-1 text-xs text-ink-400">{t('auth.login.workspaceHint')}</p>
              </div>
            )}
            <div>
              <Label htmlFor="email">{t('auth.login.email')}</Label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
              />
            </div>
            <div>
              <div className="flex items-baseline justify-between gap-2">
                <Label htmlFor="password">{t('auth.login.password')}</Label>
                <Link href="/forgot-password" className="text-xs font-medium text-brand-600 hover:text-brand-700 hover:underline">
                  {t('auth.login.forgotPassword')}
                </Link>
              </div>
              <PasswordInput
                id="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="current-password"
              />
            </div>

            {error && <Alert tone="error">{error}</Alert>}

            <Button type="submit" className="w-full" loading={submitting}>
              {submitting ? t('auth.login.submitting') : t('auth.login.submit')}
            </Button>
          </form>
        </div>
        <PoweredByFooter className="mt-4 text-center text-white/70" />
      </div>
    </div>
  );
}
