'use client';

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ChevronDown, ChevronUp, UserPlus } from 'lucide-react';
import { PERMISSIONS } from '@hrm/shared';
import type { RankedApplicationsQuery } from '@hrm/shared';
import { useI18n } from '../../../../../i18n/I18nProvider';
import { useAuth } from '../../../../../lib/auth/AuthContext';
import { useAsync } from '../../../../../lib/useAsync';
import { ApiError } from '../../../../../lib/api/client';
import { getJobRequisition, listJobPostings, updateApplicationStage } from '../../../../../lib/api/recruitment';
import { getScreeningCriteria, listRankedApplications, saveScreeningCriteria } from '../../../../../lib/api/screening';
import type { RankedApplication } from '../../../../../lib/api/screening';
import type { ApplicationStage } from '../../../../../lib/api/types';
import { Card, CardBody, CardHeader, CardTitle } from '../../../../../components/ui/Card';
import { Button } from '../../../../../components/ui/Button';
import { Alert } from '../../../../../components/ui/Alert';
import { Badge, StatusBadge } from '../../../../../components/ui/Badge';
import { Input, Label, Select } from '../../../../../components/ui/Field';
import { Modal } from '../../../../../components/ui/Modal';
import { EmptyState } from '../../../../../components/ui/EmptyState';
import { PageSpinner } from '../../../../../components/ui/Spinner';
import { ScoreBar, ScreeningBreakdown } from '../../../../../components/recruitment/ScreeningScore';
import { ScreeningCriteriaForm } from '../../../../../components/recruitment/ScreeningCriteriaForm';
import { AddApplicantForm } from '../../../../../components/recruitment/AddApplicantForm';

const STAGES: ApplicationStage[] = ['APPLIED', 'SCREEN', 'INTERVIEW', 'OFFER', 'HIRED', 'REJECTED'];
const POLL_MS = 3000;
const MAX_SKILL_CHIPS = 5;

type SortKey = NonNullable<RankedApplicationsQuery['sort']>;

/**
 * The recruiter's ranked applicant list for ONE requisition (step 9.1 — see
 * docs/conventions/resume-parsing-screening.md): criteria as editable config,
 * applicants ranked by match score with a "why" breakdown per row, filterable
 * by score / skill / years / stage, and the SAME human stage control the
 * pipeline board uses — scores never move anyone on their own.
 */
export default function ScreeningPage({ params }: { params: { requisitionId: string } }) {
  const { t } = useI18n();
  const { can } = useAuth();
  const requisitionId = params.requisitionId;

  const canView = can(PERMISSIONS.RECRUITMENT_READ) || can(PERMISSIONS.RECRUITMENT_MANAGE);
  const canWrite = can(PERMISSIONS.RECRUITMENT_WRITE);

  const [minScore, setMinScore] = useState('');
  const [minYears, setMinYears] = useState('');
  const [skill, setSkill] = useState('');
  const [stage, setStage] = useState('');
  const [flagged, setFlagged] = useState(false);
  const [sort, setSort] = useState<SortKey>('score');
  const [editingCriteria, setEditingCriteria] = useState(false);
  const [adding, setAdding] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const { data: requisition, error: requisitionError } = useAsync(() => (canView ? getJobRequisition(requisitionId) : Promise.resolve(null)), [canView, requisitionId]);
  const { data: criteria, reload: reloadCriteria } = useAsync(() => (canView ? getScreeningCriteria(requisitionId) : Promise.resolve(null)), [canView, requisitionId]);
  const { data: postings } = useAsync(() => (canView ? listJobPostings() : Promise.resolve([])), [canView]);

  // The list reloads silently (no spinner flash) — it polls while any applicant's resume is still being parsed.
  const [rows, setRows] = useState<RankedApplication[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const filters = useMemo(
    () => ({
      sort,
      minScore: minScore === '' ? undefined : Number(minScore),
      minYears: minYears === '' ? undefined : Number(minYears),
      skill: skill.trim() || undefined,
      stage: stage || undefined,
      belowThreshold: flagged ? ('true' as const) : undefined,
    }),
    [sort, minScore, minYears, skill, stage, flagged],
  );
  const load = useCallback(async () => {
    if (!canView) return;
    try {
      setRows(await listRankedApplications(requisitionId, filters));
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : t('error.generic'));
    }
  }, [canView, requisitionId, filters, t]);
  useEffect(() => {
    const handle = setTimeout(() => void load(), 250); // debounce typing in the numeric/skill filters
    return () => clearTimeout(handle);
  }, [load]);
  const anyPending = rows?.some((r) => r.candidate.parseStatus === 'PENDING') ?? false;
  useEffect(() => {
    if (!anyPending) return;
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [anyPending, load]);

  if (!canView) return <Alert tone="info">{t('error.forbidden')}</Alert>;
  if (requisitionError) return <Alert tone="error">{requisitionError}</Alert>;

  const requisitionPostings = (postings ?? []).filter((p) => p.requisitionId === requisitionId && p.status !== 'CLOSED');
  const hasFilters = minScore !== '' || minYears !== '' || skill !== '' || stage !== '' || flagged;

  async function changeStage(row: RankedApplication, next: ApplicationStage) {
    setActionError(null);
    try {
      await updateApplicationStage(row.applicationId, next);
      await load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : t('error.generic'));
    }
  }

  const config = criteria?.config ?? null;

  return (
    <div className="max-w-6xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs text-ink-400">
            <Link href="/recruitment" className="hover:underline">
              {t('nav.recruitment')}
            </Link>
          </p>
          <h1 className="page-title" data-testid="screening-title">
            {t('screening.title')}
            {requisition ? ` — ${requisition.title}` : ''}
          </h1>
        </div>
        {canWrite && requisitionPostings.length > 0 && (
          <Button data-testid="add-applicant-button" onClick={() => setAdding(true)}>
            <UserPlus className="h-4 w-4" aria-hidden />
            {t('screening.addApplicant')}
          </Button>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('screening.criteria')}</CardTitle>
          {canWrite && (
            <Button size="sm" variant="secondary" data-testid="edit-criteria-button" onClick={() => setEditingCriteria(true)}>
              {config ? t('screening.editCriteria') : t('screening.defineCriteria')}
            </Button>
          )}
        </CardHeader>
        <CardBody>
          {!config ? (
            <p className="text-sm text-ink-500" data-testid="no-criteria">
              {t('screening.noCriteria')}
            </p>
          ) : (
            <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4" data-testid="criteria-summary">
              <CriteriaItem label={t('screening.requiredSkills')} chips={config.requiredSkills} />
              <CriteriaItem label={t('screening.preferredSkills')} chips={config.preferredSkills} />
              <CriteriaItem label={t('screening.minYears')} text={config.minYearsExperience != null ? t('screening.yearsShort', { n: config.minYearsExperience }) : null} />
              <CriteriaItem label={t('screening.minEducation')} text={config.minEducation && config.minEducation !== 'NONE' ? t(`screening.education.${config.minEducation}`) : null} />
              <CriteriaItem label={t('screening.keywords')} chips={config.keywordMustHaves} />
              <CriteriaItem label={t('screening.threshold')} text={String(config.belowThresholdScore)} />
            </dl>
          )}
          <p className="mt-3 text-xs text-ink-400">{t('screening.assistNote')}</p>
        </CardBody>
      </Card>

      <Card>
        <CardBody className="space-y-4">
          <div className="flex flex-wrap items-end gap-3" role="search" aria-label={t('common.search')}>
            <div className="w-28">
              <Label htmlFor="f-score">{t('screening.filter.minScore')}</Label>
              <Input id="f-score" data-testid="filter-min-score" type="number" min={0} max={100} value={minScore} onChange={(e) => setMinScore(e.target.value)} />
            </div>
            <div className="w-28">
              <Label htmlFor="f-years">{t('screening.filter.minYears')}</Label>
              <Input id="f-years" data-testid="filter-min-years" type="number" min={0} value={minYears} onChange={(e) => setMinYears(e.target.value)} />
            </div>
            <div className="w-44">
              <Label htmlFor="f-skill">{t('screening.filter.skill')}</Label>
              <Input id="f-skill" data-testid="filter-skill" value={skill} onChange={(e) => setSkill(e.target.value)} />
            </div>
            <div className="w-40">
              <Label htmlFor="f-stage">{t('screening.filter.stage')}</Label>
              <Select id="f-stage" value={stage} onChange={(e) => setStage(e.target.value)}>
                <option value="">{t('screening.filter.allStages')}</option>
                {STAGES.map((s) => (
                  <option key={s} value={s}>
                    {t(`recruitment.stage.${s}`)}
                  </option>
                ))}
              </Select>
            </div>
            <div className="w-44">
              <Label htmlFor="f-sort">{t('screening.filter.sort')}</Label>
              <Select id="f-sort" data-testid="filter-sort" value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
                {(['score', 'experience', 'appliedAt'] as const).map((s) => (
                  <option key={s} value={s}>
                    {t(`screening.sort.${s}`)}
                  </option>
                ))}
              </Select>
            </div>
            <label className="flex items-center gap-2 pb-2.5 text-sm text-ink-700">
              <input type="checkbox" data-testid="filter-flagged" checked={flagged} onChange={(e) => setFlagged(e.target.checked)} className="h-4 w-4 rounded border-ink-300" />
              {t('screening.filter.flagged')}
            </label>
            {hasFilters && (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  setMinScore('');
                  setMinYears('');
                  setSkill('');
                  setStage('');
                  setFlagged(false);
                }}
              >
                {t('screening.filter.clear')}
              </Button>
            )}
          </div>

          {actionError && <Alert tone="error">{actionError}</Alert>}
          {loadError && <Alert tone="error">{loadError}</Alert>}

          {rows === null ? (
            <PageSpinner />
          ) : rows.length === 0 ? (
            <EmptyState title={hasFilters ? t('screening.noMatches') : t('screening.noApplicants')} />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-start text-sm" data-testid="ranked-table">
                <thead>
                  <tr className="border-b border-ink-100 text-xs uppercase tracking-wide text-ink-400">
                    <th className="py-2 pe-2 text-start font-medium">{t('screening.rank')}</th>
                    <th className="py-2 pe-3 text-start font-medium">{t('screening.candidate')}</th>
                    <th className="py-2 pe-3 text-start font-medium">{t('screening.score')}</th>
                    <th className="py-2 pe-3 text-start font-medium">{t('screening.experience')}</th>
                    <th className="py-2 pe-3 text-start font-medium">{t('screening.skills')}</th>
                    <th className="py-2 pe-3 text-start font-medium">{t('screening.filter.stage')}</th>
                    <th className="py-2 text-start font-medium">
                      <span className="sr-only">{t('common.actions')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {rows.map((row, index) => {
                    const open = expanded === row.applicationId;
                    const p = row.candidate.parseStatus;
                    return (
                      <Fragment key={row.applicationId}>
                        <tr data-testid="ranked-row" data-application-id={row.applicationId} data-score={row.screeningScore ?? ''} data-flagged={row.belowThreshold}>
                          <td className="py-3 pe-2 tabular-nums text-ink-500">{index + 1}</td>
                          <td className="py-3 pe-3">
                            <Link href={`/recruitment/candidates/${row.candidateId}`} className="font-medium text-ink-900 hover:underline" data-testid="candidate-link">
                              {row.candidate.firstName} {row.candidate.lastName}
                            </Link>
                            <div className="text-xs text-ink-400" dir="ltr">
                              {row.candidate.email}
                            </div>
                            {p !== 'PARSED' && (
                              <div className="mt-1">
                                <StatusBadge status={p} label={t(`screening.parse.${p}`)} />
                              </div>
                            )}
                          </td>
                          <td className="py-3 pe-3">
                            <ScoreBar score={row.screeningScore} belowThreshold={row.belowThreshold} />
                          </td>
                          <td className="py-3 pe-3 text-ink-700">
                            {row.candidate.totalYearsExperience != null ? t('screening.yearsShort', { n: row.candidate.totalYearsExperience }) : '—'}
                            {row.candidate.highestEducation && row.candidate.highestEducation !== 'NONE' && (
                              <div className="text-xs text-ink-400">{t(`screening.education.${row.candidate.highestEducation}`)}</div>
                            )}
                          </td>
                          <td className="py-3 pe-3">
                            <div className="flex max-w-xs flex-wrap gap-1">
                              {row.candidate.skills.slice(0, MAX_SKILL_CHIPS).map((s) => (
                                <Badge key={s}>{s}</Badge>
                              ))}
                              {row.candidate.skills.length > MAX_SKILL_CHIPS && (
                                <span className="text-xs text-ink-400">{t('screening.more', { n: row.candidate.skills.length - MAX_SKILL_CHIPS })}</span>
                              )}
                            </div>
                          </td>
                          <td className="py-3 pe-3">
                            {canWrite ? (
                              <Select
                                aria-label={t('screening.filter.stage')}
                                data-testid="stage-select"
                                value={row.stage}
                                onChange={(e) => void changeStage(row, e.target.value as ApplicationStage)}
                              >
                                {STAGES.map((s) => (
                                  <option key={s} value={s}>
                                    {t(`recruitment.stage.${s}`)}
                                  </option>
                                ))}
                              </Select>
                            ) : (
                              <StatusBadge status={row.stage} label={t(`recruitment.stage.${row.stage}`)} />
                            )}
                          </td>
                          <td className="py-3 text-end">
                            {row.screening && (
                              <Button
                                size="sm"
                                variant="secondary"
                                data-testid="why-button"
                                aria-expanded={open}
                                onClick={() => setExpanded(open ? null : row.applicationId)}
                              >
                                {open ? <ChevronUp className="h-4 w-4" aria-hidden /> : <ChevronDown className="h-4 w-4" aria-hidden />}
                                {open ? t('screening.hideWhy') : t('screening.why')}
                              </Button>
                            )}
                          </td>
                        </tr>
                        {open && row.screening && (
                          <tr>
                            <td colSpan={7} className="bg-sand-50 px-3 py-3">
                              <ScreeningBreakdown result={row.screening} />
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="text-xs text-ink-400">{t('screening.advanceHint')}</p>
        </CardBody>
      </Card>

      {editingCriteria && (
        <Modal title={t('screening.criteria')} onClose={() => setEditingCriteria(false)}>
          <ScreeningCriteriaForm
            initial={config}
            onCancel={() => setEditingCriteria(false)}
            onSave={async (input) => {
              await saveScreeningCriteria(requisitionId, input);
              setEditingCriteria(false);
              reloadCriteria();
              await load();
            }}
          />
        </Modal>
      )}
      {adding && (
        <Modal title={t('screening.addApplicant')} onClose={() => setAdding(false)}>
          <AddApplicantForm
            postings={requisitionPostings}
            onCancel={() => setAdding(false)}
            onAdded={() => {
              setAdding(false);
              void load();
            }}
          />
        </Modal>
      )}
    </div>
  );
}

function CriteriaItem({ label, chips, text }: { label: string; chips?: string[]; text?: string | null }) {
  return (
    <div>
      <dt className="text-xs font-semibold uppercase tracking-wide text-ink-400">{label}</dt>
      <dd className="mt-1 flex flex-wrap gap-1 text-ink-800">
        {chips ? chips.length === 0 ? '—' : chips.map((c) => <Badge key={c}>{c}</Badge>) : (text ?? '—')}
      </dd>
    </div>
  );
}
