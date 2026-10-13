'use client';

import { useState } from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import { ApiError } from '../../lib/api/client';
import { listColleagues, requestSwap, type MyScheduleDay } from '../../lib/api/scheduling';
import { useAsync } from '../../lib/useAsync';
import { formatDayLong } from '../../lib/scheduling';
import { Alert } from '../ui/Alert';
import { Button } from '../ui/Button';
import { Label, Textarea } from '../ui/Field';
import { Modal } from '../ui/Modal';
import { Select } from '../ui/Select';
import { ShiftChip } from './ShiftChip';

/** Hand your shift on `day` to a colleague (same branch). The colleague agrees first; then your manager chain approves in /approvals. */
export function SwapModal({ day, locale, onClose, onSaved }: { day: MyScheduleDay; locale: string; onClose: () => void; onSaved: () => void }) {
  const { t } = useI18n();
  const { data: colleagues, loading } = useAsync(() => listColleagues(), []);
  const [counterpart, setCounterpart] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function send() {
    if (!counterpart) {
      setError(t('schedule.swap.err.pick'));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await requestSwap({ date: day.date, counterpartEmployeeId: counterpart, reason: reason.trim() || undefined });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('error.generic'));
      setSaving(false);
    }
  }

  return (
    <Modal title={t('schedule.swap.title')} onClose={onClose}>
      <div className="space-y-4" data-testid="swap-modal">
        <div className="flex flex-wrap items-center gap-2 text-sm text-ink-700">
          <span>{formatDayLong(day.date, locale)}</span>
          {day.shift && <ShiftChip name={day.shift.name} color={day.shift.color} startTime={day.shift.startTime} endTime={day.shift.endTime} />}
        </div>
        <p className="text-sm text-ink-500">{t('schedule.swap.flow')}</p>
        <div>
          <Label htmlFor="swap-colleague">{t('schedule.swap.colleague')}</Label>
          <Select id="swap-colleague" searchable value={counterpart} onChange={(e) => setCounterpart(e.target.value)} disabled={loading} data-testid="swap-colleague">
            <option value="">{t('schedule.swap.pickColleague')}</option>
            {(colleagues ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label htmlFor="swap-reason">{t('schedule.swap.reason')}</Label>
          <Textarea id="swap-reason" rows={3} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t('common.optional')} data-testid="swap-reason" />
        </div>
        {error && <Alert tone="error" data-testid="swap-error">{error}</Alert>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            {t('action.cancel')}
          </Button>
          <Button onClick={send} loading={saving} data-testid="swap-send">
            {t('schedule.swap.send')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
