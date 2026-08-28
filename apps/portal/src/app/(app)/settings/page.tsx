'use client';

import { FormEvent, useState } from 'react';
import { useI18n } from '../../../i18n/I18nProvider';
import { useAuth } from '../../../lib/auth/AuthContext';
import { apiChangePassword } from '../../../lib/api/auth';
import { ApiError } from '../../../lib/api/client';
import { Card, CardBody, CardHeader, CardTitle } from '../../../components/ui/Card';
import { Button } from '../../../components/ui/Button';
import { Input, Label } from '../../../components/ui/Field';
import { Alert } from '../../../components/ui/Alert';

export default function SettingsPage() {
  const { t, locale, setLocale } = useI18n();
  const { logoutAll } = useAuth();

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  async function handleChangePassword(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setSuccess(false);
    try {
      await apiChangePassword(currentPassword, newPassword);
      setCurrentPassword('');
      setNewPassword('');
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
          <form onSubmit={handleChangePassword} className="space-y-4">
            <div>
              <Label htmlFor="currentPassword">{t('settings.currentPassword')}</Label>
              <Input id="currentPassword" type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} required />
            </div>
            <div>
              <Label htmlFor="newPassword">{t('settings.newPassword')}</Label>
              <Input id="newPassword" type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required minLength={8} />
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
