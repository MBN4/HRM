'use client';

import { FormEvent, useState } from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import { submitReview } from '../../lib/api/performance';
import { ApiError } from '../../lib/api/client';
import { Button } from '../ui/Button';
import { Input, Label, Textarea } from '../ui/Field';
import { Alert } from '../ui/Alert';
import type { Review } from '../../lib/api/types';

export function SubmitReviewForm({ assignmentId, onSubmitted, onCancel }: { assignmentId: string; onSubmitted: (review: Review) => void; onCancel: () => void }) {
  const { t } = useI18n();
  const [overallRating, setOverallRating] = useState('');
  const [strengths, setStrengths] = useState('');
  const [improvements, setImprovements] = useState('');
  const [comments, setComments] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const review = await submitReview(assignmentId, {
        overallRating: Number(overallRating),
        strengths: strengths || undefined,
        improvements: improvements || undefined,
        comments: comments || undefined,
      });
      onSubmitted(review);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('error.generic'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <Label htmlFor="review-overall-rating">{t('performance.overallRating')}</Label>
        <Input id="review-overall-rating" type="number" value={overallRating} onChange={(e) => setOverallRating(e.target.value)} required />
      </div>
      <div>
        <Label htmlFor="review-strengths">
          {t('performance.strengths')} <span className="text-ink-400">({t('common.optional')})</span>
        </Label>
        <Textarea id="review-strengths" rows={2} value={strengths} onChange={(e) => setStrengths(e.target.value)} />
      </div>
      <div>
        <Label htmlFor="review-improvements">
          {t('performance.improvements')} <span className="text-ink-400">({t('common.optional')})</span>
        </Label>
        <Textarea id="review-improvements" rows={2} value={improvements} onChange={(e) => setImprovements(e.target.value)} />
      </div>
      <div>
        <Label htmlFor="review-comments">
          {t('performance.comments')} <span className="text-ink-400">({t('common.optional')})</span>
        </Label>
        <Textarea id="review-comments" rows={2} value={comments} onChange={(e) => setComments(e.target.value)} />
      </div>

      {error && <Alert tone="error">{error}</Alert>}

      <div className="flex justify-end gap-2 border-t border-ink-100 pt-4">
        <Button type="button" variant="secondary" onClick={onCancel}>
          {t('action.cancel')}
        </Button>
        <Button type="submit" loading={submitting} data-testid="submit-review-form-button">
          {t('performance.submitReview')}
        </Button>
      </div>
    </form>
  );
}
