'use client';

import { FormEvent, useState } from 'react';
import { useI18n } from '../../../i18n/I18nProvider';
import { useAuth } from '../../../lib/auth/AuthContext';
import { apiChangePassword } from '../../../lib/api/auth';
import { ApiError } from '../../../lib/api/client';
import { Card, CardBody, CardHeader, CardTitle } from '../../../components/ui/Card';
import { Button } from '../../../components/ui/Button';
import { Label, FieldError } from '../../../components/ui/Field';
import { PasswordInput } from '../../../components/ui/PasswordInput';
import { Alert } from '../../../components/ui/Alert';

const MIN_PASSWORD_LENGTH = 8;

export default function SettingsPage() {
  const { t, locale, setLocale } = useI18n();
  const { logoutAll } = useAuth();

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmNewPassword, setConfirmNewPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  async function handleChangePassword(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setValidationError(null);
    setSuccess(false);

    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      setValidationError(t('auth.resetPassword.tooShort'));
      return;
    }
    if (newPassword !== confirmNewPassword) {
      setValidationError(t('auth.resetPassword.mismatch'));
      return;
    }

    setSaving(true);
    try {
      await apiChangePassword(currentPassword, newPassword);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmNewPassword('');
      setSuccess(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('error.generic'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="max-w-xl space-y-6">
      <h1 className="text-xl font-semibold text-ink-900">{t('settings.title')}</h1>

      <Card>
        <CardHeader>
          <CardTitle>{t('settings.language')}</CardTitle>
        </CardHeader>
        <CardBody>
          <div className="flex gap-2">
            <Button variant={locale === 'en' ? 'primary' : 'secondary'} size="sm" onClick={() => setLocale('en')}>
              English
            </Button>
            <Button variant={locale === 'ar' ? 'primary' : 'secondary'} size="sm" onClick={() => setLocale('ar')}>
              العربية
            </Button>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('settings.changePassword')}</CardTitle>
        </CardHeader>
        <CardBody>
          <form onSubmit={handleChangePassword} noValidate className="space-y-4">
            <div>
              <Label htmlFor="currentPassword">{t('settings.currentPassword')}</Label>
              <PasswordInput id="currentPassword" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} required autoComplete="current-password" />
            </div>
            <div>
              <Label htmlFor="newPassword">{t('settings.newPassword')}</Label>
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
              <Label htmlFor="confirmNewPassword">{t('settings.confirmNewPassword')}</Label>
              <PasswordInput
                id="confirmNewPassword"
                value={confirmNewPassword}
                onChange={(e) => setConfirmNewPassword(e.target.value)}
                required
                minLength={MIN_PASSWORD_LENGTH}
                autoComplete="new-password"
              />
              <FieldError>{validationError}</FieldError>
            </div>
            {error && <Alert tone="error">{error}</Alert>}
            {success && <Alert tone="success">{t('settings.passwordChanged')}</Alert>}
            <Button type="submit" loading={saving}>
              {t('action.save')}
            </Button>
          </form>
        </CardBody>
      </Card>

      <Card>
        <CardBody>
          <Button variant="danger" onClick={() => void logoutAll()}>
            {t('settings.signOutAll')}
          </Button>
        </CardBody>
      </Card>
    </div>
  );
}
