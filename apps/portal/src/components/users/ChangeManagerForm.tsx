'use client';

import { FormEvent, useState } from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import { ApiError } from '../../lib/api/client';
import { setUserManager, type HierarchyUser } from '../../lib/api/users';
import { Alert } from '../ui/Alert';
import { Button } from '../ui/Button';
import { ManagerSelect } from './ManagerSelect';

/** Modal body: reassign one user's manager. The server's 400 message (loop / self / deactivated) is shown verbatim. */
export function ChangeManagerForm({
  userId,
  currentManagerId,
  items,
  onCancel,
  onSaved,
}: {
  userId: string;
  currentManagerId: string | null;
  items?: HierarchyUser[];
  onCancel: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const [managerId, setManagerId] = useState<string | null>(currentManagerId);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await setUserManager(userId, managerId);
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('error.generic'));
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4" data-testid="change-manager-form">
      <ManagerSelect id={`manager-${userId}`} value={managerId} onChange={setManagerId} excludeUserId={userId} items={items} />
      <p className="text-xs text-ink-500">{t('manager.hint')}</p>
      {error && (
        <div data-testid="manager-error">
          <Alert tone="error">{error}</Alert>
        </div>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onCancel}>
          {t('action.cancel')}
        </Button>
        <Button type="submit" loading={submitting} data-testid="manager-save">
          {t('manager.save')}
        </Button>
      </div>
    </form>
  );
}
