'use client';

import { FormEvent, useState } from 'react';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { MAX_RATING_SCALE, MAX_SURVEY_QUESTIONS } from '@hrm/shared';
import { useI18n } from '../../i18n/I18nProvider';
import { useAsync } from '../../lib/useAsync';
import { ApiError } from '../../lib/api/client';
import { createSurvey, getSurveyAdmin, updateSurvey, type SurveyInputBody } from '../../lib/api/engagement';
import { listBranches } from '../../lib/api/tenancy';
import { getWorkingHoursTargets } from '../../lib/api/working-hours';
import type { SurveyAudienceType, SurveyDetail, SurveyQuestionType } from '../../lib/api/types';
import { Alert } from '../ui/Alert';
import { Button } from '../ui/Button';
import { Card, CardBody, CardHeader, CardTitle } from '../ui/Card';
import { Input, Label, Select, Textarea } from '../ui/Field';
import { PageSpinner } from '../ui/Spinner';
import { PeoplePicker, type PickedPerson } from './PeoplePicker';

interface DraftOption {
  id: string;
  label: string;
}
interface DraftQuestion {
  key: string;
  type: SurveyQuestionType;
  prompt: string;
  required: boolean;
  scaleMin: number;
  scaleMax: number;
  options: DraftOption[];
}

let keySeq = 0;
const nextKey = () => `dq-${(keySeq += 1)}`;

function blankOptions(): DraftOption[] {
  return [
    { id: 'o1', label: '' },
    { id: 'o2', label: '' },
  ];
}

function newQuestion(type: SurveyQuestionType = 'RATING'): DraftQuestion {
  return { key: nextKey(), type, prompt: '', required: true, scaleMin: 1, scaleMax: 5, options: blankOptions() };
}

const toLocalInput = (iso: string | null | undefined) => {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** Create or edit a DRAFT survey. Loads the audience lookups (branches/departments/people) first. */
export function SurveyBuilder({ surveyId, onSaved, onCancel }: { surveyId: string | null; onSaved: (survey: SurveyDetail) => void; onCancel: () => void }) {
  const { t } = useI18n();
  const { data, loading } = useAsync(async () => {
    const [existing, branches, targets] = await Promise.all([
      surveyId ? getSurveyAdmin(surveyId) : Promise.resolve(null),
      listBranches().catch(() => []),
      getWorkingHoursTargets().catch(() => null),
    ]);
    return { existing, branches, targets };
  }, [surveyId]);

  if (loading || !data) return <PageSpinner />;
  return <BuilderForm {...data} onSaved={onSaved} onCancel={onCancel} />;
}

function BuilderForm({
  existing,
  branches,
  targets,
  onSaved,
  onCancel,
}: {
  existing: SurveyDetail | null;
  branches: { id: string; name: string }[];
  targets: { departments: { id: string; name: string; branchName: string }[]; employees: { id: string; name: string }[] } | null;
  onSaved: (survey: SurveyDetail) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const nameOf = new Map((targets?.employees ?? []).map((e) => [e.id, e.name]));
  const [title, setTitle] = useState(existing?.title ?? '');
  const [description, setDescription] = useState(existing?.description ?? '');
  const [anonymous, setAnonymous] = useState(existing?.anonymous ?? false);
  const [audienceType, setAudienceType] = useState<SurveyAudienceType>(existing?.audienceType ?? 'ORG');
  const [audienceIds, setAudienceIds] = useState<string[]>(existing?.audienceIds ?? []);
  const [teamPeople, setTeamPeople] = useState<PickedPerson[]>(
    existing?.audienceType === 'TEAM' ? existing.audienceIds.map((id) => ({ id, name: nameOf.get(id) ?? id.slice(0, 8) })) : [],
  );
  const [opensAt, setOpensAt] = useState(toLocalInput(existing?.opensAt));
  const [closesAt, setClosesAt] = useState(toLocalInput(existing?.closesAt));
  const [questions, setQuestions] = useState<DraftQuestion[]>(
    existing
      ? existing.questions.map((q) => ({
          key: nextKey(),
          type: q.type,
          prompt: q.prompt,
          required: q.required,
          scaleMin: q.scaleMin ?? 1,
          scaleMax: q.scaleMax ?? 5,
          options: q.options ? q.options.map((o) => ({ ...o })) : blankOptions(),
        }))
      : [newQuestion()],
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const patchQuestion = (key: string, patch: Partial<DraftQuestion>) => setQuestions((qs) => qs.map((q) => (q.key === key ? { ...q, ...patch } : q)));
  const move = (index: number, delta: -1 | 1) =>
    setQuestions((qs) => {
      const next = [...qs];
      const target = index + delta;
      if (target < 0 || target >= next.length) return qs;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });

  function buildBody(): SurveyInputBody | string {
    if (!title.trim()) return t('survey.builder.err.title');
    if (audienceType !== 'ORG' && (audienceType === 'TEAM' ? teamPeople.length : audienceIds.length) === 0) return t('survey.builder.err.audience');
    if (opensAt && closesAt && new Date(closesAt) <= new Date(opensAt)) return t('survey.builder.err.dates');
    if (questions.length === 0) return t('survey.builder.err.noQuestions');
    const built = [];
    for (const [i, q] of questions.entries()) {
      if (!q.prompt.trim()) return t('survey.builder.err.prompt', { n: i + 1 });
      if (q.type === 'SINGLE_CHOICE' || q.type === 'MULTI_CHOICE') {
        const opts = q.options.filter((o) => o.label.trim());
        if (opts.length < 2) return t('survey.builder.err.options', { n: i + 1 });
        built.push({ type: q.type, prompt: q.prompt.trim(), required: q.required, options: opts.map((o) => ({ id: o.id, label: o.label.trim() })) });
      } else if (q.type === 'RATING') {
        built.push({ type: q.type, prompt: q.prompt.trim(), required: q.required, scaleMin: q.scaleMin, scaleMax: q.scaleMax });
      } else {
        built.push({ type: q.type, prompt: q.prompt.trim(), required: q.required });
      }
    }
    return {
      title: title.trim(),
      description: description.trim() || undefined,
      anonymous,
      audienceType,
      audienceIds: audienceType === 'ORG' ? [] : audienceType === 'TEAM' ? teamPeople.map((p) => p.id) : audienceIds,
      opensAt: opensAt ? new Date(opensAt).toISOString() : undefined,
      closesAt: closesAt ? new Date(closesAt).toISOString() : undefined,
      questions: built,
    };
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const body = buildBody();
    if (typeof body === 'string') {
      setError(body);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      onSaved(existing ? await updateSurvey(existing.id, body) : await createSurvey(body));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('error.generic'));
      setSaving(false);
    }
  }

  const audienceChoices = audienceType === 'BRANCH' ? branches.map((b) => ({ id: b.id, name: b.name })) : (targets?.departments ?? []).map((d) => ({ id: d.id, name: `${d.name} (${d.branchName})` }));

  return (
    <form onSubmit={submit} noValidate className="space-y-5" data-testid="survey-builder">
      <Card>
        <CardHeader>
          <CardTitle>{existing ? t('survey.builder.editTitle') : t('survey.builder.newTitle')}</CardTitle>
        </CardHeader>
        <CardBody className="space-y-4">
          <div>
            <Label htmlFor="survey-title">{t('survey.builder.title')}</Label>
            <Input id="survey-title" maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} required />
          </div>
          <div>
            <Label htmlFor="survey-description">
              {t('survey.builder.description')} ({t('common.optional')})
            </Label>
            <Textarea id="survey-description" rows={2} maxLength={2000} value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <fieldset>
            <legend className="mb-1.5 text-sm font-medium text-ink-700">{t('survey.builder.privacy')}</legend>
            <div className="space-y-2">
              {[false, true].map((v) => (
                <label key={String(v)} className="flex cursor-pointer items-start gap-2 text-sm text-ink-800">
                  <input type="radio" name="survey-anonymous" checked={anonymous === v} onChange={() => setAnonymous(v)} className="mt-1" data-testid={v ? 'survey-anonymous-yes' : 'survey-anonymous-no'} />
                  <span>
                    <span className="font-medium">{v ? t('survey.builder.anonymous') : t('survey.builder.identified')}</span>
                    <span className="block text-xs text-ink-500">{v ? t('survey.builder.anonymousHelp') : t('survey.builder.identifiedHelp')}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="survey-opens">
                {t('survey.builder.opensAt')} ({t('common.optional')})
              </Label>
              <Input id="survey-opens" type="datetime-local" value={opensAt} onChange={(e) => setOpensAt(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="survey-closes">
                {t('survey.builder.closesAt')} ({t('common.optional')})
              </Label>
              <Input id="survey-closes" type="datetime-local" value={closesAt} onChange={(e) => setClosesAt(e.target.value)} />
            </div>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('survey.builder.audience')}</CardTitle>
        </CardHeader>
        <CardBody className="space-y-4">
          <div>
            <Label htmlFor="survey-audience-type">{t('survey.builder.audienceType')}</Label>
            <Select
              id="survey-audience-type"
              value={audienceType}
              onChange={(e) => {
                setAudienceType(e.target.value as SurveyAudienceType);
                setAudienceIds([]);
                setTeamPeople([]);
              }}
            >
              {(['ORG', 'BRANCH', 'DEPARTMENT', 'TEAM'] as const).map((a) => (
                <option key={a} value={a}>
                  {t(`survey.audience.${a}`)}
                </option>
              ))}
            </Select>
            <p className="mt-1 text-xs text-ink-500">{t(`survey.audience.${audienceType}.help`)}</p>
          </div>
          {(audienceType === 'BRANCH' || audienceType === 'DEPARTMENT') && (
            <fieldset>
              <legend className="mb-1.5 text-sm font-medium text-ink-700">{audienceType === 'BRANCH' ? t('survey.builder.pickBranches') : t('survey.builder.pickDepartments')}</legend>
              {audienceChoices.length === 0 ? (
                <p className="text-sm text-ink-400">{t('common.noData')}</p>
              ) : (
                <div className="grid max-h-48 gap-1 overflow-y-auto sm:grid-cols-2">
                  {audienceChoices.map((c) => (
                    <label key={c.id} className="flex items-center gap-2 text-sm text-ink-800">
                      <input type="checkbox" checked={audienceIds.includes(c.id)} onChange={() => setAudienceIds((ids) => (ids.includes(c.id) ? ids.filter((x) => x !== c.id) : [...ids, c.id]))} />
                      {c.name}
                    </label>
                  ))}
                </div>
              )}
            </fieldset>
          )}
          {audienceType === 'TEAM' && (
            <div>
              <Label htmlFor="survey-team-managers">{t('survey.builder.pickManagers')}</Label>
              <PeoplePicker inputId="survey-team-managers" label={t('survey.builder.pickManagers')} value={teamPeople} onChange={setTeamPeople} max={100} />
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('survey.builder.questions')}</CardTitle>
          <Button type="button" size="sm" variant="secondary" onClick={() => setQuestions((qs) => [...qs, newQuestion()])} disabled={questions.length >= MAX_SURVEY_QUESTIONS} data-testid="add-question-button">
            <Plus className="h-4 w-4" aria-hidden />
            {t('survey.builder.addQuestion')}
          </Button>
        </CardHeader>
        <CardBody className="space-y-4">
          {questions.map((q, i) => (
            <fieldset key={q.key} className="space-y-3 rounded-xl border border-ink-100 p-4" data-testid="builder-question">
              <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-ink-400">{t('survey.builder.questionN', { n: i + 1 })}</legend>
              <div className="flex flex-wrap items-end gap-3">
                <div className="min-w-[10rem]">
                  <Label htmlFor={`q-type-${q.key}`}>{t('survey.builder.type')}</Label>
                  <Select id={`q-type-${q.key}`} value={q.type} onChange={(e) => patchQuestion(q.key, { type: e.target.value as SurveyQuestionType })}>
                    {(['RATING', 'SINGLE_CHOICE', 'MULTI_CHOICE', 'TEXT'] as const).map((qt) => (
                      <option key={qt} value={qt}>
                        {t(`survey.qtype.${qt}`)}
                      </option>
                    ))}
                  </Select>
                </div>
                <label className="flex items-center gap-2 pb-2.5 text-sm text-ink-800">
                  <input type="checkbox" checked={q.required} onChange={(e) => patchQuestion(q.key, { required: e.target.checked })} />
                  {t('survey.builder.required')}
                </label>
                <div className="ms-auto flex items-center gap-1 pb-1">
                  <Button type="button" size="sm" variant="ghost" onClick={() => move(i, -1)} disabled={i === 0} aria-label={t('survey.builder.moveUp', { n: i + 1 })}>
                    <ArrowUp className="h-4 w-4" aria-hidden />
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => move(i, 1)} disabled={i === questions.length - 1} aria-label={t('survey.builder.moveDown', { n: i + 1 })}>
                    <ArrowDown className="h-4 w-4" aria-hidden />
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setQuestions((qs) => qs.filter((x) => x.key !== q.key))} disabled={questions.length === 1} aria-label={t('survey.builder.removeQuestion', { n: i + 1 })}>
                    <Trash2 className="h-4 w-4" aria-hidden />
                  </Button>
                </div>
              </div>
              <div>
                <Label htmlFor={`q-prompt-${q.key}`}>{t('survey.builder.prompt')}</Label>
                <Input id={`q-prompt-${q.key}`} maxLength={500} value={q.prompt} onChange={(e) => patchQuestion(q.key, { prompt: e.target.value })} data-testid="question-prompt" />
              </div>
              {q.type === 'RATING' && (
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <Label htmlFor={`q-min-${q.key}`}>{t('survey.builder.scaleMin')}</Label>
                    <Select id={`q-min-${q.key}`} value={String(q.scaleMin)} onChange={(e) => patchQuestion(q.key, { scaleMin: Number(e.target.value) })}>
                      <option value="0">0</option>
                      <option value="1">1</option>
                    </Select>
                  </div>
                  <div>
                    <Label htmlFor={`q-max-${q.key}`}>{t('survey.builder.scaleMax')}</Label>
                    <Select id={`q-max-${q.key}`} value={String(q.scaleMax)} onChange={(e) => patchQuestion(q.key, { scaleMax: Number(e.target.value) })}>
                      {Array.from({ length: MAX_RATING_SCALE - 1 }, (_, k) => k + 2).map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                    </Select>
                  </div>
                </div>
              )}
              {(q.type === 'SINGLE_CHOICE' || q.type === 'MULTI_CHOICE') && (
                <div className="space-y-2">
                  <p className="text-sm font-medium text-ink-700">{t('survey.builder.options')}</p>
                  {q.options.map((o, oi) => (
                    <div key={o.id} className="flex items-center gap-2">
                      <Input
                        aria-label={t('survey.builder.optionN', { n: oi + 1 })}
                        placeholder={t('survey.builder.optionN', { n: oi + 1 })}
                        maxLength={200}
                        value={o.label}
                        onChange={(e) => patchQuestion(q.key, { options: q.options.map((x) => (x.id === o.id ? { ...x, label: e.target.value } : x)) })}
                        data-testid="option-label"
                      />
                      <Button type="button" size="sm" variant="ghost" disabled={q.options.length <= 2} onClick={() => patchQuestion(q.key, { options: q.options.filter((x) => x.id !== o.id) })} aria-label={t('survey.builder.removeOption', { n: oi + 1 })}>
                        <Trash2 className="h-4 w-4" aria-hidden />
                      </Button>
                    </div>
                  ))}
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    disabled={q.options.length >= 20}
                    onClick={() => {
                      const used = new Set(q.options.map((o) => o.id));
                      let n = q.options.length + 1;
                      while (used.has(`o${n}`)) n += 1;
                      patchQuestion(q.key, { options: [...q.options, { id: `o${n}`, label: '' }] });
                    }}
                  >
                    <Plus className="h-4 w-4" aria-hidden />
                    {t('survey.builder.addOption')}
                  </Button>
                </div>
              )}
            </fieldset>
          ))}
        </CardBody>
      </Card>

      <div aria-live="polite">{error && <Alert tone="error">{error}</Alert>}</div>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onCancel}>
          {t('action.cancel')}
        </Button>
        <Button type="submit" loading={saving} data-testid="save-survey-button">
          {t('survey.builder.saveDraft')}
        </Button>
      </div>
    </form>
  );
}
