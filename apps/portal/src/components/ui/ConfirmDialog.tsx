'use client';

import { useState } from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import { ApiError } from '../../lib/api/client';
import { Alert } from './Alert';
import { Button } from './Button';
import { Modal } from './Modal';

/**
 * A confirm-before-acting dialog on top of `Modal` (which supplies the
 * focus trap / Esc / aria-modal behavior). Owns the in-flight + error
 * state so every caller doesn't re-implement it: `onConfirm` may reject,
 * in which case the server's own message is shown and the dialog stays open.
 */
export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  tone = 'primary',
  onConfirm,
  onClose,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  tone?: 'primary' | 'danger';
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setWorking(true);
    setError(null);
    try {
      await onConfirm();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('error.generic'));
      setWorking(false);
    }
  }

  return (
    <Modal title={title} onClose={onClose}>
      <div className="space-y-4">
        <p className="text-sm text-ink-600">{body}</p>
        {error && <Alert tone="error">{error}</Alert>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={working}>
            {t('users.confirm.cancel')}
          </Button>
          <Button variant={tone === 'danger' ? 'danger' : 'primary'} onClick={confirm} loading={working} data-testid="confirm-dialog-confirm">
            {working ? t('users.confirm.working') : confirmLabel}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
