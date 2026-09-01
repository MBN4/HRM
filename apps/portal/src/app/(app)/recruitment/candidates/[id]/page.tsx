'use client';

import { useState } from 'react';
import { PERMISSIONS } from '@hrm/shared';
import { useI18n } from '../../../../../i18n/I18nProvider';
import { useAuth } from '../../../../../lib/auth/AuthContext';
import { useAsync } from '../../../../../lib/useAsync';
import { formatDateTime } from '../../../../../lib/format';
import { getCandidate, listApplications, listInterviewsForApplication, listScorecards } from '../../../../../lib/api/recruitment';
import { Card, CardBody, CardHeader, CardTitle } from '../../../../../components/ui/Card';
import { Button } from '../../../../../components/ui/Button';
import { Alert } from '../../../../../components/ui/Alert';
import { StatusBadge } from '../../../../../components/ui/Badge';
import { Modal } from '../../../../../components/ui/Modal';
import { PageSpinner } from '../../../../../components/ui/Spinner';
import { ScheduleInterviewForm } from '../../../../../components/recruitment/ScheduleInterviewForm';
import { SubmitScorecardForm } from '../../../../../components/recruitment/SubmitScorecardForm';
import type { Application, Interview } from '../../../../../lib/api/types';

function InterviewBlock({ interview, canWrite }: { interview: Interview; canWrite: boolean }) {
  const { t, locale } = useI18n();
  const [submitting, setSubmitting] = useState(false);
  const { data: scorecards, loading, reload } = useAsync(() => listScorecards(interview.id), [interview.id]);

  return (
    <div data-testid="interview-row" className="rounded-lg border border-ink-100 p-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-ink-800">{formatDateTime(interview.scheduledAt, locale)}</p>
        <StatusBadge status={interview.status} label={interview.status} />
      </div>
      <p className="mt-1 text-xs text-ink-500">
        {t('recruitment.duration')}: {interview.durationMinutes} · {t('recruitment.location')}: {interview.location ?? '—'}
      </p>

      <div className="mt-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-ink-400">{t('recruitment.scorecard')}</p>
        {loading ? (
          <PageSpinner />
        ) : !scorecards || scorecards.length === 0 ? (
          <p className="text-sm text-ink-400">{t('common.noData')}</p>
        ) : (
          <ul className="mt-1 space-y-1">
            {scorecards.map((s) => (
              <li key={s.id} data-testid="scorecard-row" className="text-sm text-ink-600">
                {t(`recruitment.recommendationValue.${s.recommendation}`)} — {s.rating}/5{s.notes ? ` — ${s.notes}` : ''}
              </li>
            ))}
          </ul>
        )}

        {canWrite && (
          <Button data-testid="submit-scorecard-button" size="sm" variant="secondary" className="mt-2" onClick={() => setSubmitting(true)}>
            {t('recruitment.submitScorecard')}
          </Button>
        )}
      </div>

      {submitting && (
        <Modal title={t('recruitment.submitScorecard')} onClose={() => setSubmitting(false)}>
          <SubmitScorecardForm
            interviewId={interview.id}
            onCancel={() => setSubmitting(false)}
            onSubmitted={() => {
              setSubmitting(false);
              reload();
            }}
          />
        </Modal>
      )}
    </div>
  );
}

function ApplicationBlock({ application, canWrite }: { application: Application; canWrite: boolean }) {
  const { t } = useI18n();
  const [scheduling, setScheduling] = useState(false);
  const { data: interviews, loading, reload } = useAsync(() => listInterviewsForApplication(application.id), [application.id]);

  return (
    <Card data-testid="application-block">
      <CardHeader>
        <CardTitle>{t(`recruitment.stage.${application.stage}`)}</CardTitle>
        {canWrite && (
          <Button data-testid="schedule-interview-button" size="sm" onClick={() => setScheduling(true)}>
            {t('recruitment.scheduleInterview')}
          </Button>
        )}
      </CardHeader>
      <CardBody className="space-y-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-ink-400">{t('recruitment.interviews')}</p>
        {loading ? (
          <PageSpinner />
        ) : !interviews || interviews.length === 0 ? (
          <p className="text-sm text-ink-400">{t('common.noData')}</p>
        ) : (
          <div className="space-y-3">
            {interviews.map((interview) => (
              <InterviewBlock key={interview.id} interview={interview} canWrite={canWrite} />
            ))}
          </div>
        )}
      </CardBody>

      {scheduling && (
        <Modal title={t('recruitment.scheduleInterview')} onClose={() => setScheduling(false)}>
          <ScheduleInterviewForm
            applicationId={application.id}
            onCancel={() => setScheduling(false)}
            onScheduled={() => {
              setScheduling(false);
              reload();
            }}
          />
        </Modal>
      )}
    </Card>
  );
}

export default function CandidateDetailPage({ params }: { params: { id: string } }) {
  const { t } = useI18n();
  const { can } = useAuth();

  const canView = can(PERMISSIONS.RECRUITMENT_READ) || can(PERMISSIONS.RECRUITMENT_MANAGE);
  const canWrite = can(PERMISSIONS.RECRUITMENT_WRITE);

  const { data: candidate, loading, error } = useAsync(() => (canView ? getCandidate(params.id) : Promise.resolve(null)), [canView, params.id]);
  const { data: applications, loading: loadingApplications } = useAsync(
    () => (canView ? listApplications({ candidateId: params.id }) : Promise.resolve([])),
    [canView, params.id],
  );

  if (!canView) {
    return <Alert tone="info">{t('error.forbidden')}</Alert>;
  }

  if (loading) return <PageSpinner />;
  if (error) return <Alert tone="error">{error}</Alert>;
  if (!candidate) return <Alert tone="info">{t('error.notFound')}</Alert>;

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-ink-900">
          {candidate.firstName} {candidate.lastName}
        </h1>
        <p className="text-sm text-ink-500">{candidate.email}</p>
        {candidate.resumeStorageKey && <p className="mt-1 text-xs text-ink-400">{t('recruitment.resumeOnFile')}</p>}
      </div>

      <div>
        <h2 className="mb-2 text-sm font-semibold text-ink-900">{t('recruitment.applications')}</h2>
        {loadingApplications ? (
          <PageSpinner />
        ) : !applications || applications.length === 0 ? (
          <p className="text-sm text-ink-400">{t('common.noData')}</p>
        ) : (
          <div className="space-y-4">
            {applications.map((application) => (
              <ApplicationBlock key={application.id} application={application} canWrite={canWrite} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
