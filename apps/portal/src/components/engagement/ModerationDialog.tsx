'use client';

import { FormEvent, useState } from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import { ApiError } from '../../lib/api/client';
import { Alert } from '../ui/Alert';
import { Button } from '../ui/Button';
import { Label, Textarea } from '../ui/Field';
import { Modal } from '../ui/Modal';

/** Confirm-and-remove with an optional reason (the server records it in the audit trail). */
export function ModerationDialog({ title, body, withReason = true, onConfirm, onClose }: { title: string; body: string; withReason?: boolean; onConfirm: (reason?: string) => Promise<void>; onClose: () => void }) {
  const { t } = useI18n();
  const [reason, setReason] = useState('');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setWorking(true);
    setError(null);
    try {
      await onConfirm(reason.trim() || undefined);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('error.generic'));
      setWorking(false);
    }
  }

  return (
    <Modal title={title} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <p className="text-sm text-ink-600">{body}</p>
        {withReason && (
          <div>
            <Label htmlFor="moderation-reason">
              {t('feed.moderation.reason')} ({t('common.optional')})
            </Label>
            <Textarea id="moderation-reason" rows={2} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
        )}
        {error && <Alert tone="error">{error}</Alert>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={working}>
            {t('action.cancel')}
          </Button>
          <Button type="submit" variant="danger" loading={working} data-testid="confirm-remove">
            {t('common.remove')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
