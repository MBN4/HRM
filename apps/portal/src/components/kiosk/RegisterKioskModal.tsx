'use client';

import { FormEvent, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { useI18n } from '../../i18n/I18nProvider';
import { ApiError } from '../../lib/api/client';
import { kioskLaunchUrl, registerKiosk, type KioskWithToken } from '../../lib/api/kiosk';
import type { Branch } from '../../lib/api/types';
import { Alert } from '../ui/Alert';
import { Button } from '../ui/Button';
import { CopyField } from '../ui/CopyField';
import { Input, Label, Select } from '../ui/Field';
import { Modal } from '../ui/Modal';

/** Shows a freshly issued device token ONCE (register / rotate) with the launch link that pairs a screen automatically. */
export function KioskTokenPanel({ kiosk, onDone }: { kiosk: KioskWithToken; onDone: () => void }) {
  const { t } = useI18n();
  return (
    <div className="space-y-4" data-testid="kiosk-token-panel">
      <p className="text-sm text-ink-700">
        {t('kiosk.admin.token.intro', { name: kiosk.name, branch: kiosk.branchName })}
      </p>
      <CopyField
        value={kiosk.token}
        label={t('kiosk.admin.token.label')}
        copyLabel={t('users.temp.copy')}
        copiedLabel={t('users.temp.copied')}
        data-testid="kiosk-token-value"
      />
      <Alert tone="info">{t('kiosk.admin.token.once')}</Alert>
      <a
        href={kioskLaunchUrl(kiosk.token)}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-2 text-sm font-medium text-brand-700 underline underline-offset-2"
        data-testid="kiosk-launch-link"
      >
        <ExternalLink className="h-4 w-4" aria-hidden />
        {t('kiosk.admin.token.launch')}
      </a>
      <p className="text-xs text-ink-500">{t('kiosk.admin.token.launchHint')}</p>
      <div className="flex justify-end">
        <Button onClick={onDone} data-testid="kiosk-token-done">
          {t('kiosk.admin.token.done')}
        </Button>
      </div>
    </div>
  );
}

export function RegisterKioskModal({
  branches,
  onClose,
  onRegistered,
}: {
  branches: Branch[];
  onClose: () => void;
  onRegistered: () => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [branchId, setBranchId] = useState(branches[0]?.id ?? '');
  const [requirePhoto, setRequirePhoto] = useState(false);
  const [biometricEnabled, setBiometricEnabled] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<KioskWithToken | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      setCreated(
        await registerKiosk({ name: name.trim(), branchId, requirePhoto, biometricEnabled }),
      );
      onRegistered();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('error.generic'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      title={created ? t('kiosk.admin.token.title') : t('kiosk.admin.register.title')}
      onClose={onClose}
    >
      {created ? (
        <KioskTokenPanel kiosk={created} onDone={onClose} />
      ) : (
        <form onSubmit={submit} className="space-y-4" data-testid="kiosk-register-form">
          <div>
            <Label htmlFor="kiosk-name">{t('kiosk.admin.field.name')}</Label>
            <Input
              id="kiosk-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
              required
              placeholder={t('kiosk.admin.field.namePlaceholder')}
              data-testid="kiosk-register-name"
            />
          </div>
          <div>
            <Label htmlFor="kiosk-branch">{t('kiosk.admin.field.branch')}</Label>
            <Select
              id="kiosk-branch"
              value={branchId}
              onChange={(e) => setBranchId(e.target.value)}
              data-testid="kiosk-register-branch"
            >
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </Select>
            <p className="mt-1 text-xs text-ink-400">{t('kiosk.admin.field.branchHint')}</p>
          </div>
          <label className="flex items-start gap-3 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4"
              checked={requirePhoto}
              onChange={(e) => setRequirePhoto(e.target.checked)}
              data-testid="kiosk-register-photo"
            />
            <span>
              <span className="font-medium text-ink-800">
                {t('kiosk.admin.field.requirePhoto')}
              </span>
              <span className="block text-ink-500">{t('kiosk.admin.field.requirePhotoHint')}</span>
            </span>
          </label>
          <label className="flex items-start gap-3 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4"
              checked={biometricEnabled}
              onChange={(e) => setBiometricEnabled(e.target.checked)}
              data-testid="kiosk-register-biometric"
            />
            <span>
              <span className="font-medium text-ink-800">{t('kiosk.admin.field.biometric')}</span>
              <span className="block text-ink-500">{t('kiosk.admin.field.biometricHint')}</span>
            </span>
          </label>
          {error && <Alert tone="error">{error}</Alert>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              {t('action.cancel')}
            </Button>
            <Button
              type="submit"
              loading={submitting}
              disabled={!name.trim() || !branchId}
              data-testid="kiosk-register-submit"
            >
              {t('kiosk.admin.register.submit')}
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
