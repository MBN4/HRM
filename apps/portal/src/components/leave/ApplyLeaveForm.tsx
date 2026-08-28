'use client';

import { FormEvent, useState } from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import { submitLeaveRequest } from '../../lib/api/leave';
import { ApiError } from '../../lib/api/client';
import { LEAVE_TYPES } from '@hrm/shared';
import { Button } from '../ui/Button';
import { Input, Label, Select, Textarea } from '../ui/Field';
import { Alert } from '../ui/Alert';

export function ApplyLeaveForm({ onSubmitted, onCancel }: { onSubmitted: () => void; onCancel: () => void }) {
  const { t } = useI18n();
  const [leaveType, setLeaveType] = useState<(typeof LEAVE_TYPES)[number]>('ANNUAL');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await submitLeaveRequest({ leaveType, startDate, endDate, reason: reason || undefined });
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
        <Label htmlFor="leaveType">{t('leave.leaveType')}</Label>
        <Select id="leaveType" value={leaveType} onChange={(e) => setLeaveType(e.target.value as typeof leaveType)}>
          {LEAVE_TYPES.map((lt) => (
            <option key={lt} value={lt}>
              {t(`leave.type.${lt}`)}
            </option>
          ))}
        </Select>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <Label htmlFor="startDate">{t('leave.startDate')}</Label>
          <Input id="startDate" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} required />
        </div>
        <div>
          <Label htmlFor="endDate">{t('leave.endDate')}</Label>
          <Input id="endDate" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} required />
        </div>
      </div>
      <div>
        <Label htmlFor="reason">
          {t('common.reason')} <span className="text-ink-400">({t('common.optional')})</span>
        </Label>
        <Textarea id="reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>

      {error && <Alert tone="error">{error}</Alert>}

      <div className="flex justify-end gap-2 border-t border-ink-100 pt-4">
        <Button type="button" variant="secondary" onClick={onCancel}>
          {t('action.cancel')}
        </Button>
        <Button type="submit" loading={submitting}>
          {t('leave.submit')}
        </Button>
      </div>
    </form>
  );
}
