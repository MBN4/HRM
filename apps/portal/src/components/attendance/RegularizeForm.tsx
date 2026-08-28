'use client';

import { FormEvent, useState } from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import { submitRegularization } from '../../lib/api/attendance';
import { ApiError } from '../../lib/api/client';
import { Button } from '../ui/Button';
import { Input, Label, Textarea } from '../ui/Field';
import { Alert } from '../ui/Alert';

export function RegularizeForm({ onSubmitted, onCancel }: { onSubmitted: () => void; onCancel: () => void }) {
  const { t } = useI18n();
  const [workDate, setWorkDate] = useState('');
  const [requestedClockInAt, setRequestedClockInAt] = useState('');
  const [requestedClockOutAt, setRequestedClockOutAt] = useState('');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await submitRegularization({
        workDate,
        requestedClockInAt: requestedClockInAt ? new Date(requestedClockInAt).toISOString() : undefined,
        requestedClockOutAt: requestedClockOutAt ? new Date(requestedClockOutAt).toISOString() : undefined,
        reason,
      });
      onSubmitted();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('error.generic'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <Label htmlFor="workDate">{t('attendance.workDate')}</Label>
        <Input id="workDate" type="date" value={workDate} onChange={(e) => setWorkDate(e.target.value)} required />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <Label htmlFor="requestedClockInAt">{t('attendance.requestedClockIn')}</Label>
          <Input id="requestedClockInAt" type="datetime-local" value={requestedClockInAt} onChange={(e) => setRequestedClockInAt(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="requestedClockOutAt">{t('attendance.requestedClockOut')}</Label>
          <Input id="requestedClockOutAt" type="datetime-local" value={requestedClockOutAt} onChange={(e) => setRequestedClockOutAt(e.target.value)} />
        </div>
      </div>
      <div>
        <Label htmlFor="reason">{t('common.reason')}</Label>
        <Textarea id="reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} required />
      </div>

      {error && <Alert tone="error">{error}</Alert>}

      <div className="flex justify-end gap-2 border-t border-ink-100 pt-4">
        <Button type="button" variant="secondary" onClick={onCancel}>
          {t('action.cancel')}
        </Button>
        <Button type="submit" loading={submitting}>
          {t('common.submit')}
        </Button>
      </div>
    </form>
  );
}
