'use client';

import { FormEvent, useState } from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import { submitScorecard } from '../../lib/api/recruitment';
import { ApiError } from '../../lib/api/client';
import { Button } from '../ui/Button';
import { Input, Label, Select, Textarea } from '../ui/Field';
import { Alert } from '../ui/Alert';
import type { InterviewScorecard, ScorecardRecommendation } from '../../lib/api/types';

const RECOMMENDATIONS: ScorecardRecommendation[] = ['STRONG_YES', 'YES', 'NO', 'STRONG_NO'];

/**
 * A 403 here means the caller isn't on the interview panel and doesn't
 * hold `recruitment.manage` (row-level gating in `InterviewService.
 * submitScorecard`) — rendered inline via the same `ApiError` ->
 * `<Alert tone="error">` catch every form in this codebase already uses,
 * never left to bubble up and crash the page.
 */
export function SubmitScorecardForm({ interviewId, onSubmitted, onCancel }: { interviewId: string; onSubmitted: (scorecard: InterviewScorecard) => void; onCancel: () => void }) {
  const { t } = useI18n();
  const [rating, setRating] = useState(3);
  const [recommendation, setRecommendation] = useState<ScorecardRecommendation>('YES');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const scorecard = await submitScorecard(interviewId, { rating, recommendation, notes: notes || undefined });
      onSubmitted(scorecard);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('error.generic'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div>
          <Label htmlFor="scorecard-rating">{t('recruitment.rating')}</Label>
          <Input id="scorecard-rating" type="number" min={1} max={5} value={rating} onChange={(e) => setRating(Number(e.target.value))} required />
        </div>
        <div>
          <Label htmlFor="scorecard-recommendation">{t('recruitment.recommendation')}</Label>
          <Select id="scorecard-recommendation" value={recommendation} onChange={(e) => setRecommendation(e.target.value as ScorecardRecommendation)}>
            {RECOMMENDATIONS.map((r) => (
              <option key={r} value={r}>
                {t(`recruitment.recommendationValue.${r}`)}
              </option>
            ))}
          </Select>
        </div>
      </div>
      <div>
        <Label htmlFor="scorecard-notes">
          {t('recruitment.notes')} <span className="text-ink-400">({t('common.optional')})</span>
        </Label>
        <Textarea id="scorecard-notes" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>

      {error && <Alert tone="error">{error}</Alert>}

      <div className="flex justify-end gap-2 border-t border-ink-100 pt-4">
        <Button type="button" variant="secondary" onClick={onCancel}>
          {t('action.cancel')}
        </Button>
        <Button type="submit" loading={submitting} data-testid="submit-scorecard-form-button">
          {t('recruitment.submitScorecard')}
        </Button>
      </div>
    </form>
  );
}
