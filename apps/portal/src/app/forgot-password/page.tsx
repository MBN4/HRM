'use client';

import { FormEvent, useEffect, useState } from 'react';
import Link from 'next/link';
import { useI18n } from '../../i18n/I18nProvider';
import { useBranding } from '../../lib/branding/BrandingProvider';
import { getStoredTenantSlug, isUsingSubdomainResolution, setStoredTenantSlug } from '../../lib/tenant';
import { apiRequestPasswordReset } from '../../lib/api/auth';
import { Button } from '../../components/ui/Button';
import { Input, Label } from '../../components/ui/Field';
import { Alert } from '../../components/ui/Alert';
import { PoweredByFooter } from '../../components/layout/PoweredByFooter';

/**
 * "Request reset" screen — see docs/conventions/frontend-ess-mss.md →
 * "Forgot / reset password". Calls `POST /auth/request-password-reset`
 * (already-existing, `@AllowAnonymous()`, tenant-scoped) and always shows
 * the SAME neutral confirmation regardless of whether the account exists —
 * matching the API's own enumeration-safe posture (it always responds
 * `204`). A real error (network failure, rate limit, etc.) is the only
 * thing that produces an error state here.
 */
export default function ForgotPasswordPage() {
  const { t } = useI18n();
  const { branding, logoUrl } = useBranding();

  const [tenantSlug, setTenantSlug] = useState('');
  const [email, setEmail] = useState('');
  const [showWorkspaceField, setShowWorkspaceField] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    setShowWorkspaceField(!isUsingSubdomainResolution());
    setTenantSlug(getStoredTenantSlug() ?? '');
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      if (showWorkspaceField && tenantSlug) setStoredTenantSlug(tenantSlug);
      await apiRequestPasswordReset(email);
      setSubmitted(true);
    } catch {
      // A genuine transport/server failure — never surfaced as "account not
      // found" (the API itself never tells us that either).
      setError(t('error.generic'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-brand-900 via-brand-800 to-ink-900 px-4">
      <div className="w-full max-w-md">
        <div className="mb-8 flex items-center justify-center gap-2">
          {logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- a tenant-branded logo is an arbitrary uploaded image, not a build-time static asset next/image can optimize.
            <img src={logoUrl} alt={branding.productName} className="h-10 w-10 rounded-xl object-contain" />
          ) : (
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-white text-lg font-bold text-brand-700">
              {branding.productName.charAt(0).toUpperCase()}
            </div>
          )}
          <span className="text-xl font-semibold text-white">{branding.productName}</span>
        </div>
        <div className="rounded-xl2 bg-white p-8 shadow-soft">
          <h1 className="text-lg font-semibold text-ink-900">{t('auth.forgotPassword.title')}</h1>
          <p className="mt-1 text-sm text-ink-500">{t('auth.forgotPassword.subtitle')}</p>

          {submitted ? (
            <div className="mt-6 space-y-4">
              <Alert tone="success" data-testid="forgot-password-confirmation">
                {t('auth.forgotPassword.confirmation')}
              </Alert>
              <Link href="/login" className="block text-center text-sm font-medium text-brand-600 hover:text-brand-700 hover:underline">
                {t('auth.forgotPassword.backToLogin')}
              </Link>
            </div>
          ) : (
            <form onSubmit={handleSubmit} noValidate className="mt-6 space-y-4">
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
                <Label htmlFor="email">{t('auth.forgotPassword.email')}</Label>
                <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
              </div>

              {error && <Alert tone="error">{error}</Alert>}

              <Button type="submit" className="w-full" loading={submitting}>
                {submitting ? t('auth.forgotPassword.submitting') : t('auth.forgotPassword.submit')}
              </Button>

              <Link href="/login" className="block text-center text-sm font-medium text-brand-600 hover:text-brand-700 hover:underline">
                {t('auth.forgotPassword.backToLogin')}
              </Link>
            </form>
          )}
        </div>
        <PoweredByFooter className="mt-4 text-center text-white/70" />
      </div>
    </div>
  );
}
