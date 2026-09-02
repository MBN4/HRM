'use client';

import { useState } from 'react';
import { PERMISSIONS } from '@hrm/shared';
import { useI18n } from '../../../../i18n/I18nProvider';
import { useAuth } from '../../../../lib/auth/AuthContext';
import { useAsync } from '../../../../lib/useAsync';
import {
  downloadContentFile,
  enrollInCourse,
  getCourse,
  getQuizForTaking,
  listMyEnrollments,
  markContentComplete,
} from '../../../../lib/api/lms';
import { ApiError } from '../../../../lib/api/client';
import { Card, CardBody, CardHeader, CardTitle } from '../../../../components/ui/Card';
import { Button } from '../../../../components/ui/Button';
import { Alert } from '../../../../components/ui/Alert';
import { StatusBadge } from '../../../../components/ui/Badge';
import { PageSpinner } from '../../../../components/ui/Spinner';
import { QuizTaker } from '../../../../components/lms/QuizTaker';

export default function CourseDetailPage({ params }: { params: { id: string } }) {
  const { t } = useI18n();
  const { can } = useAuth();
  const [enrollError, setEnrollError] = useState<string | null>(null);
  const [enrolling, setEnrolling] = useState(false);
  const [busyItemId, setBusyItemId] = useState<string | null>(null);
  // A passing attempt flips the enrollment to COMPLETED as a side effect of
  // `reloadEnrollments()` below — without this flag, the quiz card (and the
  // pass/fail result it's showing) would unmount itself the instant that
  // reload lands, before the learner ever sees "Passed". Once true, the
  // card stays visible for the rest of this page view.
  const [quizJustCompleted, setQuizJustCompleted] = useState(false);

  const canView = can(PERMISSIONS.LMS_READ);
  const canEnroll = can(PERMISSIONS.LMS_ENROLL);

  const { data: course, loading, error, reload } = useAsync(() => (canView ? getCourse(params.id) : Promise.resolve(null)), [canView, params.id]);
  const { data: enrollments, reload: reloadEnrollments } = useAsync(() => (canView ? listMyEnrollments() : Promise.resolve([])), [canView]);
  const { data: quiz } = useAsync(() => (canView ? getQuizForTaking(params.id) : Promise.resolve(null)), [canView, params.id]);

  if (!canView) {
    return <Alert tone="info">{t('error.forbidden')}</Alert>;
  }
  if (loading) return <PageSpinner />;
  if (error) return <Alert tone="error">{error}</Alert>;
  if (!course) return <Alert tone="info">{t('error.notFound')}</Alert>;

  const enrollment = enrollments?.find((e) => e.courseId === course.id && e.status !== 'COMPLETED') ?? enrollments?.find((e) => e.courseId === course.id);

  async function handleEnroll() {
    setEnrolling(true);
    setEnrollError(null);
    try {
      await enrollInCourse(course!.id);
      reloadEnrollments();
    } catch (err) {
      setEnrollError(err instanceof ApiError ? err.message : t('error.generic'));
    } finally {
      setEnrolling(false);
    }
  }

  async function handleMarkComplete(itemId: string) {
    if (!enrollment) return;
    setBusyItemId(itemId);
    try {
      await markContentComplete(enrollment.id, itemId);
      reloadEnrollments();
    } catch {
      // no-op — best-effort, matches this codebase's row-action posture elsewhere.
    } finally {
      setBusyItemId(null);
    }
  }

  const progressByItemId = new Map((enrollment?.progress ?? []).map((p) => [p.contentItemId, p]));

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-ink-900">{course.title}</h1>
        {course.description && <p className="mt-1 text-sm text-ink-600">{course.description}</p>}
      </div>

      {!enrollment ? (
        <Card>
          <CardBody className="flex items-center justify-between">
            <p className="text-sm text-ink-600">{t('lms.enroll')}?</p>
            <div className="space-y-2">
              {enrollError && <Alert tone="error">{enrollError}</Alert>}
              {canEnroll && (
                <Button onClick={handleEnroll} loading={enrolling} data-testid="enroll-button">
                  {t('lms.enroll')}
                </Button>
              )}
            </div>
          </CardBody>
        </Card>
      ) : (
        <>
          {enrollment.status === 'COMPLETED' && <Alert tone="success">{t('lms.status.COMPLETED')}</Alert>}

          <Card>
            <CardHeader>
              <CardTitle>{t('lms.admin.content')}</CardTitle>
              <StatusBadge status={enrollment.status} label={t(`lms.status.${enrollment.status}`)} />
            </CardHeader>
            <CardBody>
              <ul className="divide-y divide-ink-100">
                {course.contentItems.map((item) => {
                  const progress = progressByItemId.get(item.id);
                  const isCompleted = progress?.status === 'COMPLETED';
                  return (
                    <li key={item.id} className="flex items-center justify-between gap-3 py-2.5" data-testid="content-item-row">
                      <div>
                        <p className="text-sm text-ink-800">{item.title}</p>
                        <p className="text-xs text-ink-400">{t(`lms.content.type.${item.type}`)}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        {item.storageKey && (
                          <Button variant="ghost" size="sm" onClick={() => downloadContentFile(course.id, item.id, item.title)}>
                            {t(`lms.content.type.${item.type}`)}
                          </Button>
                        )}
                        {item.externalUrl && (
                          <a href={item.externalUrl} target="_blank" rel="noreferrer" className="text-sm text-brand-700 hover:underline">
                            {t(`lms.content.type.${item.type}`)}
                          </a>
                        )}
                        {isCompleted ? (
                          <StatusBadge status="COMPLETED" label={t('lms.content.completed')} />
                        ) : (
                          <Button
                            size="sm"
                            variant="secondary"
                            loading={busyItemId === item.id}
                            onClick={() => handleMarkComplete(item.id)}
                            data-testid="mark-content-complete-button"
                          >
                            {t('lms.content.markComplete')}
                          </Button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </CardBody>
          </Card>

          {quiz && (enrollment.status !== 'COMPLETED' || quizJustCompleted) && (
            <Card>
              <CardHeader>
                <CardTitle>{quiz.title}</CardTitle>
              </CardHeader>
              <CardBody>
                <QuizTaker
                  quiz={quiz}
                  enrollmentId={enrollment.id}
                  onSubmitted={(attempt) => {
                    if (attempt.passed) setQuizJustCompleted(true);
                    reloadEnrollments();
                  }}
                />
              </CardBody>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
