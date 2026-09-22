'use client';

import { FormEvent, Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useI18n } from '../../i18n/I18nProvider';
import { useBranding } from '../../lib/branding/BrandingProvider';
import { getStoredTenantSlug, isUsingSubdomainResolution, setStoredTenantSlug } from '../../lib/tenant';
import { ApiError } from '../../lib/api/client';
import { apiResetPassword } from '../../lib/api/auth';
import { Button } from '../../components/ui/Button';
import { Input, Label, FieldError } from '../../components/ui/Field';
import { PasswordInput } from '../../components/ui/PasswordInput';
import { Alert } from '../../components/ui/Alert';
import { PoweredByFooter } from '../../components/layout/PoweredByFooter';

const MIN_PASSWORD_LENGTH = 8;

/**
 * "Reset password" screen — see docs/conventions/frontend-ess-mss.md →
 * "Forgot / reset password". Reached via the link/code emailed by
 * `POST /auth/request-password-reset`; the token travels as a `?token=`
 * query param (real email isn't wired locally — the 0.8 dev/log
 * notification provider prints it to the API console instead, see that
 * doc section for exactly how to read it). Also accepts the token pasted
 * by hand, for the same reason.
 */
function ResetPasswordForm() {
  const { t } = useI18n();
  const { branding, logoUrl } = useBranding();
  const searchParams = useSearchParams();

  const [tenantSlug, setTenantSlug] = useState('');
  const [showWorkspaceField, setShowWorkspaceField] = useState(false);
  const [token, setToken] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    setShowWorkspaceField(!isUsingSubdomainResolution());
    setTenantSlug(getStoredTenantSlug() ?? '');
    const tokenFromUrl = searchParams.get('token');
    if (tokenFromUrl) setToken(tokenFromUrl);
    const tenantFromUrl = searchParams.get('tenant');
    if (tenantFromUrl) setTenantSlug(tenantFromUrl);
  }, [searchParams]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setValidationError(null);

    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      setValidationError(t('auth.resetPassword.tooShort'));
      return;
    }
    if (newPassword !== confirmPassword) {
      setValidationError(t('auth.resetPassword.mismatch'));
      return;
    }

    setSubmitting(true);
    try {
      if (showWorkspaceField && tenantSlug) setStoredTenantSlug(tenantSlug);
      await apiResetPassword(token, newPassword);
      setSuccess(true);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setError(t('auth.resetPassword.invalidOrExpired'));
      } else {
        setError(t('error.generic'));
      }
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
          <h1 className="text-lg font-semibold text-ink-900">{t('auth.resetPassword.title')}</h1>
          <p className="mt-1 text-sm text-ink-500">{t('auth.resetPassword.subtitle')}</p>

          {success ? (
            <div className="mt-6 space-y-4">
              <Alert tone="success" data-testid="reset-password-success">
                {t('auth.resetPassword.success')}
              </Alert>
              <Link href="/login" className="block text-center text-sm font-medium text-brand-600 hover:text-brand-700 hover:underline">
                {t('auth.resetPassword.goToLogin')}
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
                </div>
              )}
              <div>
                <Label htmlFor="token">{t('auth.resetPassword.token')}</Label>
                <Input id="token" value={token} onChange={(e) => setToken(e.target.value)} required autoComplete="one-time-code" />
                <p className="mt-1 text-xs text-ink-400">{t('auth.resetPassword.tokenHint')}</p>
              </div>
              <div>
                <Label htmlFor="newPassword">{t('auth.resetPassword.newPassword')}</Label>
                <PasswordInput
                  id="newPassword"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  required
                  minLength={MIN_PASSWORD_LENGTH}
                  autoComplete="new-password"
                />
              </div>
              <div>
                <Label htmlFor="confirmPassword">{t('auth.resetPassword.confirmPassword')}</Label>
                <PasswordInput
                  id="confirmPassword"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                  minLength={MIN_PASSWORD_LENGTH}
                  autoComplete="new-password"
                />
                <FieldError>{validationError}</FieldError>
              </div>

              {error && (
                <Alert tone="error" data-testid="reset-password-error">
                  {error}
                </Alert>
              )}

              <Button type="submit" className="w-full" loading={submitting}>
                {submitting ? t('auth.resetPassword.submitting') : t('auth.resetPassword.submit')}
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

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={null}>
      <ResetPasswordForm />
    </Suspense>
  );
}
