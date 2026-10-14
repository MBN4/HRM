'use client';

import { FormEvent, useState } from 'react';
import { EDUCATION_LEVELS, SCREENING_CRITERION_KEYS } from '@hrm/shared';
import type { EducationLevel, ScreeningCriteriaConfig, ScreeningCriteriaConfigInput } from '@hrm/shared';
import { useI18n } from '../../i18n/I18nProvider';
import { ApiError } from '../../lib/api/client';
import { Alert } from '../ui/Alert';
import { Button } from '../ui/Button';
import { Input, Label, Select, Textarea } from '../ui/Field';

const list = (s: string) => s.split(/[,\n]/).map((x) => x.trim()).filter(Boolean);

/** Screening criteria are CONFIG DATA on the requisition — this form is just an editor for that JSON; no scoring logic lives here. */
export function ScreeningCriteriaForm({
  initial,
  onSave,
  onCancel,
}: {
  initial: ScreeningCriteriaConfig | null;
  onSave: (input: ScreeningCriteriaConfigInput) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const [required, setRequired] = useState((initial?.requiredSkills ?? []).join(', '));
  const [preferred, setPreferred] = useState((initial?.preferredSkills ?? []).join(', '));
  const [minYears, setMinYears] = useState(initial?.minYearsExperience != null ? String(initial.minYearsExperience) : '');
  const [minEducation, setMinEducation] = useState<EducationLevel | ''>(initial?.minEducation && initial.minEducation !== 'NONE' ? initial.minEducation : '');
  const [keywords, setKeywords] = useState((initial?.keywordMustHaves ?? []).join(', '));
  const [threshold, setThreshold] = useState(String(initial?.belowThresholdScore ?? 40));
  const [weights, setWeights] = useState<Record<string, string>>(
    Object.fromEntries(SCREENING_CRITERION_KEYS.map((k) => [k, String(initial?.weights?.[k] ?? { requiredSkills: 40, preferredSkills: 15, experience: 20, education: 10, keywords: 15 }[k])])),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await onSave({
        requiredSkills: list(required),
        preferredSkills: list(preferred),
        minYearsExperience: minYears.trim() === '' ? null : Number(minYears),
        minEducation: minEducation === '' ? null : minEducation,
        keywordMustHaves: list(keywords),
        belowThresholdScore: Number(threshold),
        weights: Object.fromEntries(SCREENING_CRITERION_KEYS.map((k) => [k, Number(weights[k])])) as ScreeningCriteriaConfigInput['weights'],
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('error.generic'));
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4" data-testid="criteria-form">
      <Alert tone="info">{t('screening.assistNote')}</Alert>
      <div>
        <Label htmlFor="sc-required">
          {t('screening.requiredSkills')} ({t('screening.commaHint')})
        </Label>
        <Textarea id="sc-required" data-testid="criteria-required-input" rows={2} value={required} onChange={(e) => setRequired(e.target.value)} />
      </div>
      <div>
        <Label htmlFor="sc-preferred">
          {t('screening.preferredSkills')} ({t('screening.commaHint')})
        </Label>
        <Textarea id="sc-preferred" data-testid="criteria-preferred-input" rows={2} value={preferred} onChange={(e) => setPreferred(e.target.value)} />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor="sc-years">{t('screening.minYears')}</Label>
          <Input id="sc-years" data-testid="criteria-years-input" type="number" min={0} max={70} step="0.5" value={minYears} onChange={(e) => setMinYears(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="sc-edu">{t('screening.minEducation')}</Label>
          <Select id="sc-edu" value={minEducation} onChange={(e) => setMinEducation(e.target.value as EducationLevel | '')}>
            <option value="">{t('screening.anyEducation')}</option>
            {EDUCATION_LEVELS.filter((l) => l !== 'NONE').map((l) => (
              <option key={l} value={l}>
                {t(`screening.education.${l}`)}
              </option>
            ))}
          </Select>
        </div>
      </div>
      <div>
        <Label htmlFor="sc-keywords">
          {t('screening.keywords')} ({t('screening.commaHint')})
        </Label>
        <Textarea id="sc-keywords" rows={2} value={keywords} onChange={(e) => setKeywords(e.target.value)} />
      </div>
      <fieldset>
        <legend className="mb-1 text-sm font-medium text-ink-800">{t('screening.weights')}</legend>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          {SCREENING_CRITERION_KEYS.map((k) => (
            <div key={k}>
              <Label htmlFor={`sc-w-${k}`}>{t(`screening.criterion.${k}`)}</Label>
              <Input id={`sc-w-${k}`} type="number" min={0} max={100} value={weights[k]} onChange={(e) => setWeights({ ...weights, [k]: e.target.value })} />
            </div>
          ))}
        </div>
      </fieldset>
      <div className="max-w-xs">
        <Label htmlFor="sc-threshold">{t('screening.threshold')}</Label>
        <Input id="sc-threshold" type="number" min={0} max={100} value={threshold} onChange={(e) => setThreshold(e.target.value)} />
      </div>

      {error && <Alert tone="error">{error}</Alert>}
      <div className="flex justify-end gap-2 border-t border-ink-100 pt-4">
        <Button type="button" variant="secondary" onClick={onCancel}>
          {t('action.cancel')}
        </Button>
        <Button type="submit" loading={saving} data-testid="save-criteria-button">
          {t('action.save')}
        </Button>
      </div>
    </form>
  );
}
