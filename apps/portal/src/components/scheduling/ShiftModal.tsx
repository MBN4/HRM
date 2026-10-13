'use client';

import { FormEvent, useState } from 'react';
import { shiftDurationMinutes, shiftToWorkingHours } from '@hrm/shared';
import { useI18n } from '../../i18n/I18nProvider';
import { ApiError } from '../../lib/api/client';
import { createShift, updateShift, type ShiftDefinition, type ShiftInput } from '../../lib/api/scheduling';
import { DEFAULT_SHIFT_COLOR, isOvernight } from '../../lib/scheduling';
import { Alert } from '../ui/Alert';
import { Button } from '../ui/Button';
import { FieldError, Input, Label } from '../ui/Field';
import { Modal } from '../ui/Modal';

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

interface Values {
  name: string;
  startTime: string;
  endTime: string;
  breakMinutes: string;
  graceMinutes: string;
  halfDay: string;
  color: string;
  minStaffing: string;
}

const blank: Values = { name: '', startTime: '09:00', endTime: '17:00', breakMinutes: '60', graceMinutes: '15', halfDay: '', color: DEFAULT_SHIFT_COLOR, minStaffing: '' };

const fromShift = (s: ShiftDefinition): Values => ({
  name: s.name,
  startTime: s.startTime,
  endTime: s.endTime,
  breakMinutes: String(s.breakMinutes),
  graceMinutes: String(s.graceMinutes),
  halfDay: s.halfDayThresholdHours === null ? '' : String(s.halfDayThresholdHours),
  color: s.color ?? DEFAULT_SHIFT_COLOR,
  minStaffing: s.minStaffing === null ? '' : String(s.minStaffing),
});

const num = (v: string) => (v.trim() === '' ? NaN : Number(v));

/** Create / edit a shift. The "derived hours" line uses the same `shiftToWorkingHours` the resolver uses — one mapping. */
export function ShiftModal({ shift, onClose, onSaved }: { shift?: ShiftDefinition; onClose: () => void; onSaved: () => void }) {
  const { t } = useI18n();
  const [v, setV] = useState<Values>(shift ? fromShift(shift) : blank);
  const [errors, setErrors] = useState<Partial<Record<keyof Values, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const set = (k: keyof Values) => (e: { target: { value: string } }) => setV((s) => ({ ...s, [k]: e.target.value }));

  const timesOk = TIME_RE.test(v.startTime) && TIME_RE.test(v.endTime) && v.startTime !== v.endTime;
  const brk = num(v.breakMinutes);
  const derived =
    timesOk && Number.isInteger(brk) && brk >= 0 && brk < shiftDurationMinutes(v.startTime, v.endTime)
      ? shiftToWorkingHours({ startTime: v.startTime, endTime: v.endTime, breakMinutes: brk, graceMinutes: 0, halfDayThresholdHours: null })
      : null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    const errs: typeof errors = {};
    if (!v.name.trim()) errs.name = t('scheduling.shift.err.name');
    if (!TIME_RE.test(v.startTime)) errs.startTime = t('scheduling.shift.err.time');
    if (!TIME_RE.test(v.endTime)) errs.endTime = t('scheduling.shift.err.time');
    if (!errs.startTime && !errs.endTime && v.startTime === v.endTime) errs.endTime = t('scheduling.shift.err.same');
    if (!Number.isInteger(brk) || brk < 0 || brk > 600) errs.breakMinutes = t('scheduling.shift.err.break');
    else if (timesOk && brk >= shiftDurationMinutes(v.startTime, v.endTime)) errs.breakMinutes = t('scheduling.shift.err.breakLong');
    const grace = num(v.graceMinutes);
    if (!Number.isInteger(grace) || grace < 0 || grace > 240) errs.graceMinutes = t('scheduling.shift.err.grace');
    let half: number | null = null;
    if (v.halfDay.trim() !== '') {
      half = num(v.halfDay);
      if (!(half > 0)) errs.halfDay = t('scheduling.shift.err.half');
      else if (timesOk && half >= shiftDurationMinutes(v.startTime, v.endTime) / 60) errs.halfDay = t('scheduling.shift.err.halfBelow');
    }
    let min: number | null = null;
    if (v.minStaffing.trim() !== '') {
      min = num(v.minStaffing);
      if (!Number.isInteger(min) || min < 0) errs.minStaffing = t('scheduling.shift.err.min');
    }
    if (!COLOR_RE.test(v.color)) errs.color = t('scheduling.shift.err.color');
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;

    const body: ShiftInput = { name: v.name.trim(), startTime: v.startTime, endTime: v.endTime, breakMinutes: brk, graceMinutes: grace, halfDayThresholdHours: half, color: v.color, minStaffing: min };
    setSaving(true);
    try {
      if (shift) await updateShift(shift.id, body);
      else await createShift(body);
      onSaved();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : t('error.generic'));
      setSaving(false);
    }
  }

  const f = (k: keyof Values, label: string, input: React.ReactNode) => (
    <div>
      <Label htmlFor={`shift-${k}`}>{label}</Label>
      {input}
      <FieldError>{errors[k]}</FieldError>
    </div>
  );

  return (
    <Modal title={shift ? t('scheduling.shift.edit') : t('scheduling.shift.add')} onClose={onClose}>
      <form onSubmit={submit} noValidate className="space-y-4" data-testid="shift-form">
        {f('name', t('scheduling.shift.name'), <Input id="shift-name" value={v.name} onChange={set('name')} maxLength={200} data-testid="shift-name" />)}
        <div className="grid grid-cols-2 gap-4">
          {f('startTime', t('scheduling.shift.start'), <Input id="shift-startTime" type="time" value={v.startTime} onChange={set('startTime')} data-testid="shift-start" />)}
          {f('endTime', t('scheduling.shift.end'), <Input id="shift-endTime" type="time" value={v.endTime} onChange={set('endTime')} data-testid="shift-end" />)}
        </div>
        {timesOk && isOvernight(v.startTime, v.endTime) && <Alert tone="info">{t('scheduling.shift.overnightHint')}</Alert>}
        <div className="grid grid-cols-2 gap-4">
          {f('breakMinutes', t('scheduling.shift.break'), <Input id="shift-breakMinutes" type="number" min={0} max={600} value={v.breakMinutes} onChange={set('breakMinutes')} data-testid="shift-break" />)}
          {f('graceMinutes', t('scheduling.shift.grace'), <Input id="shift-graceMinutes" type="number" min={0} max={240} value={v.graceMinutes} onChange={set('graceMinutes')} data-testid="shift-grace" />)}
        </div>
        <div className="grid grid-cols-2 gap-4">
          {f('halfDay', t('scheduling.shift.halfDay'), <Input id="shift-halfDay" type="number" step="0.25" min={0} value={v.halfDay} onChange={set('halfDay')} placeholder={t('scheduling.shift.halfDayAuto')} data-testid="shift-halfday" />)}
          {f('minStaffing', t('scheduling.shift.minStaffing'), <Input id="shift-minStaffing" type="number" min={0} value={v.minStaffing} onChange={set('minStaffing')} placeholder={t('common.optional')} data-testid="shift-min" />)}
        </div>
        {f(
          'color',
          t('scheduling.shift.color'),
          <div className="flex items-center gap-2">
            <input
              type="color"
              aria-label={t('scheduling.shift.color')}
              value={COLOR_RE.test(v.color) ? v.color : DEFAULT_SHIFT_COLOR}
              onChange={set('color')}
              className="h-10 w-14 cursor-pointer rounded-lg border border-ink-200 bg-surface p-1"
              data-testid="shift-color-picker"
            />
            <Input id="shift-color" value={v.color} onChange={set('color')} maxLength={7} className="max-w-[8rem] font-mono" data-testid="shift-color" />
          </div>,
        )}
        <p className="rounded-lg bg-sand-100 px-3 py-2 text-xs text-ink-600" data-testid="shift-derived" aria-live="polite">
          {derived
            ? t('scheduling.shift.derived', { required: derived.requiredHours, work: derived.workHours, brk: derived.breakHours, half: derived.halfDayThresholdHours })
            : t('scheduling.shift.derivedNone')}
        </p>
        {formError && <Alert tone="error" data-testid="shift-error">{formError}</Alert>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={saving}>
            {t('action.cancel')}
          </Button>
          <Button type="submit" loading={saving} data-testid="shift-save">
            {t('action.save')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
