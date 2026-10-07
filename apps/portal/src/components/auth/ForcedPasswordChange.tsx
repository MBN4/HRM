'use client';

import { FormEvent, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { useI18n } from '../../i18n/I18nProvider';
import { useAuth } from '../../lib/auth/AuthContext';
import { useBranding } from '../../lib/branding/BrandingProvider';
import { ApiError } from '../../lib/api/client';
import { Alert } from '../ui/Alert';
import { Button } from '../ui/Button';
import { Label } from '../ui/Field';
import { PasswordInput } from '../ui/PasswordInput';
import { Wordmark } from '../brand/Wordmark';
import { PoweredByFooter } from '../layout/PoweredByFooter';
import { PolicyLinks } from '../layout/PolicyLinks';

const MIN_PASSWORD_LENGTH = 8;

/**
 * The forced first-login screen (step 7.1) — rendered by `(app)/layout.tsx`'s
 * `AuthGate` INSTEAD of the app shell while `user.mustChangePassword` is
 * true, so no shell/session data is fetched (the server 403s all of it
 * anyway: this is UX on top of the server-side enforcement, never the
 * control). Mirrors the reset-password screen: new + confirm with the eye
 * toggle. There is deliberately no "current password" field — the user
 * authenticated with the temporary one moments ago.
 */
export function ForcedPasswordChange() {
  const { t } = useI18n();
  const { completeFirstLogin, logout } = useAuth();
  const { branding, logoUrl } = useBranding();

  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      setError(t('auth.resetPassword.tooShort'));
      return;
    }
    if (newPassword !== confirmPassword) {
      setError(t('auth.resetPassword.mismatch'));
      return;
    }
    setSubmitting(true);
    try {
      // On success the AuthContext reloads `user` (mustChangePassword=false)
      // and the gate swaps this screen for the app by itself.
      await completeFirstLogin(newPassword);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('error.generic'));
      setSubmitting(false);
    }
  }

  return (
    <div className="auth-backdrop flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-8 flex justify-center">
          <Wordmark name={branding.productName} logoUrl={logoUrl} tint={branding.primaryColor} tone="light" size="lg" />
        </div>
        <div className="auth-card" data-testid="forced-password-change">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand-50 text-brand-600">
              <ShieldCheck className="h-5 w-5" aria-hidden />
            </span>
            <h1 className="text-xl font-semibold tracking-tight text-ink-900">{t('auth.firstLogin.title')}</h1>
          </div>
          <p className="mt-2 text-sm text-ink-500">{t('auth.firstLogin.subtitle')}</p>

          <form onSubmit={handleSubmit} noValidate className="mt-6 space-y-4">
            <div>
              <Label htmlFor="firstLoginNew">{t('auth.resetPassword.newPassword')}</Label>
              <PasswordInput id="firstLoginNew" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required autoComplete="new-password" />
              <p className="mt-1 text-xs text-ink-400">{t('auth.resetPassword.tooShort')}</p>
            </div>
            <div>
              <Label htmlFor="firstLoginConfirm">{t('auth.resetPassword.confirmPassword')}</Label>
              <PasswordInput id="firstLoginConfirm" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} required autoComplete="new-password" />
            </div>

            {error && <Alert tone="error" data-testid="forced-password-error">{error}</Alert>}

            <Button type="submit" className="w-full" loading={submitting}>
              {submitting ? t('auth.firstLogin.submitting') : t('auth.firstLogin.submit')}
            </Button>
            <button
              type="button"
              onClick={() => void logout()}
              className="block w-full text-center text-sm font-medium text-brand-600 hover:text-brand-700 hover:underline"
            >
              {t('auth.firstLogin.signOut')}
            </button>
          </form>
        </div>
        <PoweredByFooter className="mt-4 text-center text-white/70" />
        <PolicyLinks className="mt-2 text-center text-white/70" />
      </div>
    </div>
  );
}
