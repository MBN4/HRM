'use client';

import { FormEvent, ReactNode, useState } from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import { ApiError } from '../../lib/api/client';
import type { WorkingHoursInput, WorkingHoursPolicy } from '../../lib/api/working-hours';
import { Alert } from '../ui/Alert';
import { Button } from '../ui/Button';
import { FieldError, Input, Label } from '../ui/Field';

export interface PolicyFormValues {
  startTime: string;
  workHours: string;
  breakHours: string;
  graceMinutes: string;
  halfDay: string;
}

export const DEFAULT_FORM: PolicyFormValues = { startTime: '09:00', workHours: '8', breakHours: '1', graceMinutes: '15', halfDay: '' };

export function valuesFromPolicy(p: WorkingHoursPolicy | null | undefined): PolicyFormValues {
  if (!p) return DEFAULT_FORM;
  return {
    startTime: p.startTime,
    workHours: String(p.workHours),
    breakHours: String(p.breakHours),
    graceMinutes: String(p.graceMinutes),
    halfDay: p.halfDayThresholdHours === null ? '' : String(p.halfDayThresholdHours),
  };
}

type Errors = Partial<Record<keyof PolicyFormValues, string>>;

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function num(v: string): number {
  return v.trim() === '' ? NaN : Number(v);
}

function fmt(n: number): string {
  return String(Math.round(n * 100) / 100);
}

/** Mirrors the server's validation so errors show inline before a round trip. */
export function validate(v: PolicyFormValues, t: (k: string) => string): { errors: Errors; input: WorkingHoursInput | null } {
  const errors: Errors = {};
  const work = num(v.workHours);
  const brk = num(v.breakHours);
  const grace = num(v.graceMinutes);
  if (!TIME_RE.test(v.startTime)) errors.startTime = t('workingHours.err.startTime');
  if (!(work > 0)) errors.workHours = t('workingHours.err.work');
  if (!(brk >= 0)) errors.breakHours = t('workingHours.err.break');
  if (!Number.isInteger(grace) || grace < 0) errors.graceMinutes = t('workingHours.err.grace');
  if (!errors.workHours && !errors.breakHours && work + brk > 24) errors.breakHours = t('workingHours.err.total');
  let half: number | null = null;
  if (v.halfDay.trim() !== '') {
    half = num(v.halfDay);
    if (!(half > 0)) errors.halfDay = t('workingHours.err.half');
    else if (!errors.workHours && !errors.breakHours && half >= work + brk) errors.halfDay = t('workingHours.err.halfBelow');
  }
  if (Object.keys(errors).length > 0) return { errors, input: null };
  return { errors, input: { startTime: v.startTime, workHours: work, breakHours: brk, graceMinutes: grace, halfDayThresholdHours: half } };
}

/**
 * The shared working-hours policy form (company default + team/member
 * overrides). Live "work + break = required" line and a derived half-day
 * hint; inline errors mirror the server and the server's own 400 message
 * is shown verbatim on top. `idPrefix` + `testPrefix` keep ids/testids
 * unique per use; `extra` renders above the fields (the override target).
 */
export function PolicyForm({
  idPrefix,
  testPrefix,
  initial,
  submitLabel,
  onSubmit,
  onCancel,
  extra,
  formTestId,
  validateExtra,
}: {
  idPrefix: string;
  testPrefix: string;
  initial: PolicyFormValues;
  submitLabel: string;
  onSubmit: (input: WorkingHoursInput) => Promise<void>;
  onCancel?: () => void;
  extra?: ReactNode;
  formTestId: string;
  /** Returns an error message when the extra (target) selection is invalid. */
  validateExtra?: () => string | null;
}) {
  const { t } = useI18n();
  const [v, setV] = useState<PolicyFormValues>(initial);
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const set = (k: keyof PolicyFormValues) => (e: { target: { value: string } }) => {
    setSaved(false);
    setV((s) => ({ ...s, [k]: e.target.value }));
  };

  const work = num(v.workHours);
  const brk = num(v.breakHours);
  const required = work > 0 && brk >= 0 ? work + brk : null;
  const halfBlank = v.halfDay.trim() === '';

  async function submit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    setSaved(false);
    const extraErr = validateExtra?.() ?? null;
    const { errors: errs, input } = validate(v, t);
    setErrors(errs);
    if (extraErr) {
      setFormError(extraErr);
      return;
    }
    if (!input) {
      setFormError(t('workingHours.err.fix'));
      return;
    }
    setSubmitting(true);
    try {
      await onSubmit(input);
      setSaved(true);
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : t('error.generic'));
    } finally {
      setSubmitting(false);
    }
  }

  const field = (k: keyof PolicyFormValues, label: string, input: ReactNode) => (
    <div>
      <Label htmlFor={`${idPrefix}-${k}`}>{label}</Label>
      {input}
      <FieldError>{errors[k]}</FieldError>
    </div>
  );

  const common = (k: keyof PolicyFormValues) => ({
    id: `${idPrefix}-${k}`,
    value: v[k],
    onChange: set(k),
    'aria-invalid': errors[k] ? true : undefined,
  });

  return (
    <form onSubmit={submit} noValidate className="space-y-4" data-testid={formTestId}>
      {extra}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {field('startTime', t('workingHours.field.startTime'), <Input type="time" {...common('startTime')} data-testid={`${testPrefix}-start`} />)}
        {field('workHours', t('workingHours.field.workHours'), <Input type="number" min="0" step="0.25" inputMode="decimal" {...common('workHours')} data-testid={`${testPrefix}-work`} />)}
        {field('breakHours', t('workingHours.field.breakHours'), <Input type="number" min="0" step="0.25" inputMode="decimal" {...common('breakHours')} data-testid={`${testPrefix}-break`} />)}
        {field('graceMinutes', t('workingHours.field.grace'), <Input type="number" min="0" step="1" inputMode="numeric" {...common('graceMinutes')} data-testid={`${testPrefix}-grace`} />)}
        {field(
          'halfDay',
          t('workingHours.field.halfDay'),
          <Input type="number" min="0" step="0.25" inputMode="decimal" placeholder={t('workingHours.field.halfDayPlaceholder')} {...common('halfDay')} data-testid={`${testPrefix}-halfday`} />,
        )}
      </div>
      <div className="space-y-1 text-sm text-ink-600" aria-live="polite">
        <p data-testid={`${testPrefix}-required`}>
          {required === null
            ? t('workingHours.required.invalid')
            : t('workingHours.required.sum', { work: fmt(work), brk: fmt(brk), total: fmt(required) })}
        </p>
        {halfBlank && required !== null && <p className="text-ink-500">{t('workingHours.halfDay.derived', { value: fmt(required / 2) })}</p>}
      </div>
      {formError && (
        <div data-testid={`${testPrefix}-error`}>
          <Alert tone="error">{formError}</Alert>
        </div>
      )}
      {saved && (
        <div data-testid={`${testPrefix}-saved`}>
          <Alert tone="success">{t('workingHours.saved')}</Alert>
        </div>
      )}
      <div className="flex justify-end gap-2">
        {onCancel && (
          <Button type="button" variant="secondary" onClick={onCancel}>
            {t('action.cancel')}
          </Button>
        )}
        <Button type="submit" loading={submitting} data-testid={`${testPrefix}-save`}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
