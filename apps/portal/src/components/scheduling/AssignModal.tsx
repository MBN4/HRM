'use client';

import { useState } from 'react';
import { CalendarOff, Eraser } from 'lucide-react';
import { useI18n } from '../../i18n/I18nProvider';
import { ApiError } from '../../lib/api/client';
import type { GridShift, RosterCellInput } from '../../lib/api/scheduling';
import { setRosterCells } from '../../lib/api/scheduling';
import { Alert } from '../ui/Alert';
import { Button } from '../ui/Button';
import { Modal } from '../ui/Modal';
import { ShiftChip } from './ShiftChip';

type Choice = { kind: 'shift'; shiftId: string } | { kind: 'dayOff' } | { kind: 'clear' };

/** Assign a shift / a day off / clear — for one cell or a multi-selection. Writes DRAFT cells (or edits published ones live). */
export function AssignModal({
  shifts,
  cells,
  publishedCount,
  title,
  onClose,
  onSaved,
}: {
  shifts: GridShift[];
  cells: { employeeId: string; date: string }[];
  publishedCount: number;
  title: string;
  onClose: () => void;
  onSaved: (written: number) => void;
}) {
  const { t } = useI18n();
  const [choice, setChoice] = useState<Choice | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const same = (a: Choice | null, b: Choice) => !!a && a.kind === b.kind && (a.kind !== 'shift' || (b.kind === 'shift' && a.shiftId === b.shiftId));

  async function apply() {
    if (!choice) return;
    setSaving(true);
    setError(null);
    try {
      const payload: RosterCellInput[] = cells.map((c) => ({
        employeeId: c.employeeId,
        date: c.date,
        ...(choice.kind === 'shift' ? { shiftDefinitionId: choice.shiftId } : choice.kind === 'dayOff' ? { dayOff: true } : {}),
      }));
      await setRosterCells(payload);
      onSaved(payload.length);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('error.generic'));
      setSaving(false);
    }
  }

  const option = (key: string, c: Choice, content: React.ReactNode, testId: string) => (
    <label
      key={key}
      className={`flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5 text-sm transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent-500 ${
        same(choice, c) ? 'border-accent-500 bg-brand-50' : 'border-ink-200 hover:bg-sand-100'
      }`}
    >
      <input type="radio" name="roster-choice" className="h-4 w-4" checked={same(choice, c)} onChange={() => setChoice(c)} data-testid={testId} />
      {content}
    </label>
  );

  return (
    <Modal title={title} onClose={onClose}>
      <div className="space-y-4" data-testid="assign-modal">
        <p className="text-sm text-ink-600">{t('scheduling.assign.cells', { count: cells.length })}</p>
        {publishedCount > 0 && <Alert tone="info">{t('scheduling.assign.publishedWarning', { count: publishedCount })}</Alert>}
        <fieldset className="space-y-2">
          <legend className="sr-only">{t('scheduling.assign.choose')}</legend>
          {shifts.map((s) => option(s.id, { kind: 'shift', shiftId: s.id }, <ShiftChip name={s.name} color={s.color} startTime={s.startTime} endTime={s.endTime} />, `assign-shift-${s.id}`))}
          {shifts.length === 0 && <p className="text-sm text-ink-500">{t('scheduling.assign.noShifts')}</p>}
          {option(
            'dayoff',
            { kind: 'dayOff' },
            <span className="flex items-center gap-2">
              <CalendarOff className="h-4 w-4" aria-hidden />
              {t('scheduling.cell.dayOff')}
            </span>,
            'assign-dayoff',
          )}
          {option(
            'clear',
            { kind: 'clear' },
            <span className="flex items-center gap-2">
              <Eraser className="h-4 w-4" aria-hidden />
              <span>
                {t('scheduling.assign.clear')}
                <span className="block text-xs text-ink-500">{t('scheduling.assign.clearHint')}</span>
              </span>
            </span>,
            'assign-clear',
          )}
        </fieldset>
        {error && <Alert tone="error" data-testid="assign-error">{error}</Alert>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            {t('action.cancel')}
          </Button>
          <Button onClick={apply} loading={saving} disabled={!choice} data-testid="assign-apply">
            {t('scheduling.assign.apply')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
