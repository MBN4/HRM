'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Plus } from 'lucide-react';
import { PERMISSIONS } from '@hrm/shared';
import { useI18n } from '../../../../i18n/I18nProvider';
import { useAuth } from '../../../../lib/auth/AuthContext';
import { useAsync } from '../../../../lib/useAsync';
import { listCourseCategories, listCourses } from '../../../../lib/api/lms';
import { Card, CardBody, CardHeader, CardTitle } from '../../../../components/ui/Card';
import { Button } from '../../../../components/ui/Button';
import { Modal } from '../../../../components/ui/Modal';
import { Alert } from '../../../../components/ui/Alert';
import { EmptyState } from '../../../../components/ui/EmptyState';
import { PageSpinner } from '../../../../components/ui/Spinner';
import { CourseCategoryForm } from '../../../../components/lms/CourseCategoryForm';
import { NewCourseForm } from '../../../../components/lms/NewCourseForm';
import { CourseAdminRow } from '../../../../components/lms/CourseAdminRow';

export default function LearningAdminPage() {
  const { t } = useI18n();
  const { can } = useAuth();
  const [addingCategory, setAddingCategory] = useState(false);
  const [addingCourse, setAddingCourse] = useState(false);

  const canAuthor = can(PERMISSIONS.LMS_AUTHOR);
  const canManage = can(PERMISSIONS.LMS_MANAGE);
  const { data: categories, reload: reloadCategories } = useAsync(() => (canAuthor ? listCourseCategories() : Promise.resolve([])), [canAuthor]);
  const { data: courses, loading, reload } = useAsync(() => (canAuthor ? listCourses() : Promise.resolve([])), [canAuthor]);

  if (!canAuthor && !canManage) {
    return <Alert tone="info">{t('error.forbidden')}</Alert>;
  }

  return (
    <div className="max-w-4xl space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-ink-900">{t('lms.admin.title')}</h1>
        {canManage && (
          <Link href="/learning/admin/compliance" className="text-sm font-medium text-brand-700 hover:underline">
            {t('lms.admin.compliance')}
          </Link>
        )}
      </div>

      {canAuthor && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>{t('lms.admin.categories')}</CardTitle>
              <Button size="sm" onClick={() => setAddingCategory(true)} data-testid="new-course-category-button">
                <Plus className="h-4 w-4" aria-hidden />
                {t('lms.admin.newCategory')}
              </Button>
            </CardHeader>
            <CardBody>
              {!categories || categories.length === 0 ? (
                <p className="text-sm text-ink-400">{t('common.noData')}</p>
              ) : (
                <ul className="divide-y divide-ink-100 text-sm">
                  {categories.map((c) => (
                    <li key={c.id} className="py-2 text-ink-800">
                      {c.name} <span className="text-ink-400">({c.code})</span>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t('lms.admin.courses')}</CardTitle>
              <Button size="sm" onClick={() => setAddingCourse(true)} disabled={!categories} data-testid="new-course-button">
                <Plus className="h-4 w-4" aria-hidden />
                {t('lms.admin.newCourse')}
              </Button>
            </CardHeader>
            <CardBody>
              {loading ? (
                <PageSpinner />
              ) : !courses || courses.length === 0 ? (
                <EmptyState title={t('lms.noCourses')} />
              ) : (
                <div className="divide-y divide-ink-100">
                  {courses.map((course) => (
                    <CourseAdminRow key={course.id} course={course} categories={categories ?? []} onChanged={reload} />
                  ))}
                </div>
              )}
            </CardBody>
          </Card>
        </>
      )}

      {addingCategory && (
        <Modal title={t('lms.admin.newCategory')} onClose={() => setAddingCategory(false)}>
          <CourseCategoryForm
            onCancel={() => setAddingCategory(false)}
            onSaved={() => {
              setAddingCategory(false);
              reloadCategories();
            }}
          />
        </Modal>
      )}

      {addingCourse && (
        <Modal title={t('lms.admin.newCourse')} onClose={() => setAddingCourse(false)}>
          <NewCourseForm
            categories={categories ?? []}
            onCancel={() => setAddingCourse(false)}
            onSaved={() => {
              setAddingCourse(false);
              reload();
            }}
          />
        </Modal>
      )}
    </div>
  );
}
