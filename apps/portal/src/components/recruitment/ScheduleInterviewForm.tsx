'use client';

import { FormEvent, useState } from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import { useAsync } from '../../lib/useAsync';
import { listEmployees } from '../../lib/api/employees';
import { scheduleInterview } from '../../lib/api/recruitment';
import { ApiError } from '../../lib/api/client';
import { Button } from '../ui/Button';
import { Input, Label } from '../ui/Field';
import { Alert } from '../ui/Alert';
import { PageSpinner } from '../ui/Spinner';
import type { Interview } from '../../lib/api/types';

/**
 * `interviewerUserIds` on an `Interview` are `User` ids, not `Employee`
 * ids — the picker is built from `listEmployees()` filtered to rows with a
 * non-null `userId`, submitting `.userId` (an employee with no linked user
 * account, e.g. one never invited to log in, can't sit on an interview
 * panel — there is no `User` id to record).
 */
export function ScheduleInterviewForm({ applicationId, onScheduled, onCancel }: { applicationId: string; onScheduled: (interview: Interview) => void; onCancel: () => void }) {
  const { t } = useI18n();
  const { data: employeeResult, loading } = useAsync(() => listEmployees({ pageSize: 200 }), []);
  const [scheduledAt, setScheduledAt] = useState('');
  const [durationMinutes, setDurationMinutes] = useState(60);
  const [location, setLocation] = useState('');
  const [selectedUserIds, setSelectedUserIds] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const interviewers = (employeeResult?.data ?? []).filter((e) => e.userId !== null);

  function toggle(userId: string) {
    setSelectedUserIds((current) => (current.includes(userId) ? current.filter((x) => x !== userId) : [...current, userId]));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!scheduledAt || selectedUserIds.length === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      const interview = await scheduleInterview({
        applicationId,
        scheduledAt: new Date(scheduledAt).toISOString(),
        durationMinutes,
        interviewerUserIds: selectedUserIds,
        location: location || undefined,
      });
      onScheduled(interview);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('error.generic'));
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) return <PageSpinner />;

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div>
          <Label htmlFor="interview-scheduled-at">{t('recruitment.scheduledAt')}</Label>
          <Input id="interview-scheduled-at" type="datetime-local" value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} required />
        </div>
        <div>
          <Label htmlFor="interview-duration">{t('recruitment.duration')}</Label>
          <Input
            id="interview-duration"
            type="number"
            min={1}
            value={durationMinutes}
            onChange={(e) => setDurationMinutes(Number(e.target.value))}
            required
          />
        </div>
      </div>
      <div>
        <Label htmlFor="interview-location">
          {t('recruitment.location')} <span className="text-ink-400">({t('common.optional')})</span>
        </Label>
        <Input id="interview-location" value={location} onChange={(e) => setLocation(e.target.value)} />
      </div>
      <div>
        <Label>{t('recruitment.interviewers')}</Label>
        <div className="max-h-48 space-y-1.5 overflow-y-auto">
          {interviewers.map((employee) => (
            <label key={employee.id} className="flex items-center gap-2 text-sm text-ink-700">
              <input
                type="checkbox"
                data-testid="interviewer-checkbox"
                checked={selectedUserIds.includes(employee.userId!)}
                onChange={() => toggle(employee.userId!)}
                className="h-4 w-4 rounded border-ink-300 text-brand-600"
              />
              {employee.firstName} {employee.lastName} ({employee.employeeCode})
            </label>
          ))}
        </div>
      </div>

      {error && <Alert tone="error">{error}</Alert>}

      <div className="flex justify-end gap-2 border-t border-ink-100 pt-4">
        <Button type="button" variant="secondary" onClick={onCancel}>
          {t('action.cancel')}
        </Button>
        <Button type="submit" loading={submitting} disabled={selectedUserIds.length === 0} data-testid="submit-schedule-interview-button">
          {t('recruitment.scheduleInterview')}
        </Button>
      </div>
    </form>
  );
}
