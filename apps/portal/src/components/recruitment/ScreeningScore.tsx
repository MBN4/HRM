'use client';

import { Check, Minus, X } from 'lucide-react';
import type { ScreeningCriterionResult, ScreeningResult } from '@hrm/shared';
import { useI18n } from '../../i18n/I18nProvider';
import { Badge } from '../ui/Badge';

/** Tone thresholds for the bar only — the real "flag" decision is the requisition's own `belowThresholdScore`. */
function barClass(score: number, belowThreshold: boolean): string {
  if (belowThreshold) return 'bg-coral-500';
  return score >= 70 ? 'bg-brand-600' : 'bg-amber-500';
}

/**
 * A score as a number AND a bar (never colour alone) with an optional
 * "below threshold" badge. `null` renders an explicit "not scored" — an
 * unscored applicant is never shown as 0.
 */
export function ScoreBar({ score, belowThreshold, notScoredLabel }: { score: number | null; belowThreshold: boolean; notScoredLabel?: string }) {
  const { t } = useI18n();
  if (score === null) {
    return <span className="text-xs text-ink-400">{notScoredLabel ?? t('screening.notScored')}</span>;
  }
  return (
    <div className="flex items-center gap-2" data-testid="score-bar">
      <div
        role="meter"
        aria-label={t('screening.score')}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={score}
        className="h-2 w-20 overflow-hidden rounded-full bg-ink-100"
      >
        <div className={`h-full rounded-full ${barClass(score, belowThreshold)}`} style={{ width: `${score}%` }} />
      </div>
      <span className="text-sm font-semibold tabular-nums text-ink-900" data-testid="score-value">
        {score}
      </span>
      {belowThreshold && <Badge tone="danger">{t('screening.belowThreshold')}</Badge>}
    </div>
  );
}

const STATUS_TONE = { MET: 'success', PARTIAL: 'warning', MISSED: 'danger' } as const;
const STATUS_ICON = { MET: Check, PARTIAL: Minus, MISSED: X } as const;

function CriterionRow({ c }: { c: ScreeningCriterionResult }) {
  const { t } = useI18n();
  const Icon = STATUS_ICON[c.status];
  const isSkillList = c.key === 'requiredSkills' || c.key === 'preferredSkills' || c.key === 'keywords';
  return (
    <li className="rounded-lg border border-ink-100 p-3" data-testid="criterion-row" data-criterion={c.key} data-status={c.status}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Icon className="h-4 w-4 text-ink-500" aria-hidden />
          <span className="text-sm font-medium text-ink-900">{t(`screening.criterion.${c.key}`)}</span>
          <Badge tone={STATUS_TONE[c.status]}>{t(`screening.status.${c.status}`)}</Badge>
        </div>
        <span className="text-xs tabular-nums text-ink-500">{t('screening.points', { earned: c.earnedPoints, max: c.maxPoints })}</span>
      </div>
      {isSkillList ? (
        <div className="mt-2 space-y-1.5">
          {c.matched.length > 0 && (
            <p className="flex flex-wrap items-center gap-1.5 text-xs text-ink-500">
              <span className="font-medium">{t('screening.matched')}:</span>
              {c.matched.map((m) => (
                <Badge key={m} tone="success">
                  {m}
                </Badge>
              ))}
            </p>
          )}
          {c.missed.length > 0 && (
            <p className="flex flex-wrap items-center gap-1.5 text-xs text-ink-500">
              <span className="font-medium">{t('screening.missed')}:</span>
              {c.missed.map((m) => (
                <Badge key={m} tone="danger">
                  {m}
                </Badge>
              ))}
            </p>
          )}
        </div>
      ) : (
        <p className="mt-1.5 text-xs text-ink-500">{c.detail}</p>
      )}
    </li>
  );
}

/** The transparency view: every configured criterion, whether it was met, the points it earned, and exactly which skills/keywords matched or were missed. */
export function ScreeningBreakdown({ result }: { result: ScreeningResult }) {
  const { t } = useI18n();
  return (
    <div className="space-y-2" data-testid="screening-breakdown">
      <ul className="space-y-2">
        {result.criteria.map((c) => (
          <CriterionRow key={c.key} c={c} />
        ))}
      </ul>
      {result.belowThreshold && <p className="text-xs text-ink-500">{t('screening.belowThresholdHint')}</p>}
      {result.basedOnEditedData && <p className="text-xs text-ink-400">{t('screening.basedOnEdited')}</p>}
    </div>
  );
}
