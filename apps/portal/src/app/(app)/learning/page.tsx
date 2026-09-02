'use client';

import Link from 'next/link';
import { PERMISSIONS } from '@hrm/shared';
import { useI18n } from '../../../i18n/I18nProvider';
import { useAuth } from '../../../lib/auth/AuthContext';
import { useAsync } from '../../../lib/useAsync';
import { listCourses, listMyCertifications, listMyEnrollments } from '../../../lib/api/lms';
import { formatDate } from '../../../lib/format';
import { Card, CardBody, CardHeader, CardTitle } from '../../../components/ui/Card';
import { Alert } from '../../../components/ui/Alert';
import { Badge, StatusBadge } from '../../../components/ui/Badge';
import { EmptyState } from '../../../components/ui/EmptyState';
import { PageSpinner } from '../../../components/ui/Spinner';

export default function LearningPage() {
  const { t, locale } = useI18n();
  const { can } = useAuth();

  const canView = can(PERMISSIONS.LMS_READ);
  const { data: courses, loading: coursesLoading } = useAsync(() => (canView ? listCourses() : Promise.resolve([])), [canView]);
  const { data: enrollments, loading: enrollmentsLoading } = useAsync(() => (canView ? listMyEnrollments() : Promise.resolve([])), [canView]);
  const { data: certifications, loading: certsLoading } = useAsync(() => (canView ? listMyCertifications() : Promise.resolve([])), [canView]);

  if (!canView) {
    return <Alert tone="info">{t('error.forbidden')}</Alert>;
  }

  function enrollmentFor(courseId: string) {
    return enrollments?.find((e) => e.courseId === courseId && e.status !== 'COMPLETED') ?? enrollments?.find((e) => e.courseId === courseId);
  }

  return (
    <div className="max-w-4xl space-y-6">
      <h1 className="text-xl font-semibold text-ink-900">{t('nav.learning')}</h1>

      <Card>
        <CardHeader>
          <CardTitle>{t('lms.catalog')}</CardTitle>
        </CardHeader>
        <CardBody>
          {coursesLoading ? (
            <PageSpinner />
          ) : !courses || courses.length === 0 ? (
            <EmptyState title={t('lms.noCourses')} />
          ) : (
            <ul className="divide-y divide-ink-100" data-testid="course-catalog-list">
              {courses.map((course) => {
                const enrollment = enrollmentFor(course.id);
                return (
                  <li key={course.id} className="flex items-center justify-between gap-3 py-2.5" data-testid="course-catalog-row">
                    <div>
                      <p className="text-sm text-ink-800">{course.title}</p>
                      {course.isMandatory && (
                        <span className="text-xs text-coral-600">{t('lms.mandatory')}</span>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      {enrollment && <StatusBadge status={enrollment.status} label={t(`lms.status.${enrollment.status}`)} />}
                      <Link href={`/learning/${course.id}`} className="text-sm font-medium text-brand-700 hover:underline" data-testid="view-course-link">
                        {enrollment ? t('lms.continue') : t('lms.viewCourse')}
                      </Link>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('lms.myCertifications')}</CardTitle>
        </CardHeader>
        <CardBody>
          {certsLoading ? (
            <PageSpinner />
          ) : !certifications || certifications.length === 0 ? (
            <EmptyState title={t('lms.noCertifications')} />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-start text-sm">
                <thead>
                  <tr className="border-b border-ink-100 text-xs uppercase tracking-wide text-ink-400">
                    <th className="py-2 text-start font-medium">{t('lms.admin.course')}</th>
                    <th className="py-2 text-start font-medium">{t('lms.certification.issuedAt')}</th>
                    <th className="py-2 text-start font-medium">{t('lms.certification.expiresAt')}</th>
                    <th className="py-2 text-start font-medium">{t('common.status')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {certifications.map((cert) => {
                    const courseTitle = courses?.find((c) => c.id === cert.courseId)?.title ?? cert.courseId;
                    return (
                      <tr key={cert.id} data-testid="my-certification-row">
                        <td className="py-2.5 text-ink-800">{courseTitle}</td>
                        <td className="py-2.5 text-ink-600">{formatDate(cert.issuedAt, locale)}</td>
                        <td className="py-2.5 text-ink-600">{cert.expiresAt ? formatDate(cert.expiresAt, locale) : <Badge>{t('lms.certification.neverExpires')}</Badge>}</td>
                        <td className="py-2.5">
                          <StatusBadge status={cert.status} label={t(`lms.certification.status.${cert.status}`)} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>

      {!enrollmentsLoading && enrollments && enrollments.some((e) => e.status !== 'COMPLETED' && e.dueDate) && (
        <Card>
          <CardHeader>
            <CardTitle>{t('lms.dueDate')}</CardTitle>
          </CardHeader>
          <CardBody>
            <ul className="space-y-1 text-sm">
              {enrollments
                .filter((e) => e.status !== 'COMPLETED' && e.dueDate)
                .map((e) => (
                  <li key={e.id} className="flex items-center justify-between">
                    <span className="text-ink-700">{courses?.find((c) => c.id === e.courseId)?.title ?? e.courseId}</span>
                    <span className="text-ink-500">{formatDate(e.dueDate, locale)}</span>
                  </li>
                ))}
            </ul>
          </CardBody>
        </Card>
      )}
    </div>
  );
}
