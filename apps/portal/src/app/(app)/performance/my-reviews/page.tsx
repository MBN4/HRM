'use client';

import { useState } from 'react';
import { PERMISSIONS } from '@hrm/shared';
import { useI18n } from '../../../../i18n/I18nProvider';
import { useAuth } from '../../../../lib/auth/AuthContext';
import { useAsync } from '../../../../lib/useAsync';
import { getMyReviewAssignments } from '../../../../lib/api/performance';
import { Card, CardBody } from '../../../../components/ui/Card';
import { Button } from '../../../../components/ui/Button';
import { Alert } from '../../../../components/ui/Alert';
import { Modal } from '../../../../components/ui/Modal';
import { EmptyState } from '../../../../components/ui/EmptyState';
import { PageSpinner } from '../../../../components/ui/Spinner';
import { SubmitReviewForm } from '../../../../components/performance/SubmitReviewForm';
import type { ReviewAssignment } from '../../../../lib/api/types';

export default function MyReviewsPage() {
  const { t } = useI18n();
  const { can } = useAuth();
  const [reviewingId, setReviewingId] = useState<string | null>(null);

  const canReview = can(PERMISSIONS.PERFORMANCE_REVIEW);
  const { data: assignments, loading, reload } = useAsync(() => (canReview ? getMyReviewAssignments() : Promise.resolve([])), [canReview]);

  if (!canReview) {
    return <Alert tone="info">{t('error.forbidden')}</Alert>;
  }

  return (
    <div className="max-w-3xl space-y-6">
      <h1 className="text-xl font-semibold text-ink-900">{t('performance.myReviews')}</h1>

      <Card>
        <CardBody>
          {loading ? (
            <PageSpinner />
          ) : !assignments || assignments.length === 0 ? (
            <EmptyState title={t('performance.noReviewAssignments')} />
          ) : (
            <ul className="divide-y divide-ink-100">
              {assignments.map((assignment: ReviewAssignment) => (
                <li key={assignment.id} data-testid="review-assignment-row" className="flex items-center justify-between py-3">
                  <span className="text-sm font-medium text-ink-800">{t(`performance.reviewType.${assignment.reviewType}`)}</span>
                  <Button data-testid="submit-review-button" size="sm" onClick={() => setReviewingId(assignment.id)}>
                    {t('performance.submitReview')}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      {reviewingId && (
        <Modal title={t('performance.submitReview')} onClose={() => setReviewingId(null)}>
          <SubmitReviewForm
            assignmentId={reviewingId}
            onCancel={() => setReviewingId(null)}
            onSubmitted={() => {
              setReviewingId(null);
              reload();
            }}
          />
        </Modal>
      )}
    </div>
  );
}
