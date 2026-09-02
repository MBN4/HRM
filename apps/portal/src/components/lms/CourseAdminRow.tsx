'use client';

import { FormEvent, useState } from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import { useAsync } from '../../lib/useAsync';
import { addContentItem, archiveCourse, assignCourse, downloadContentFile, getCourse, getQuizForAdmin, publishCourse, uploadContentFile } from '../../lib/api/lms';
import { ApiError } from '../../lib/api/client';
import { listEmployees } from '../../lib/api/employees';
import type { Course, CourseCategory, CourseWithContent } from '../../lib/api/types';
import { Button } from '../ui/Button';
import { Input, Label, Select } from '../ui/Field';
import { Alert } from '../ui/Alert';
import { StatusBadge } from '../ui/Badge';
import { QuizAdminEditor } from './QuizAdminEditor';

const CONTENT_TYPES = ['VIDEO', 'DOCUMENT', 'LINK'] as const;

export function CourseAdminRow({ course, categories, onChanged }: { course: Course; categories: CourseCategory[]; onChanged: () => void }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: detail, reload: reloadDetail } = useAsync<CourseWithContent | null>(() => getCourse(course.id), [course.id]);
  const { data: quiz, reload: reloadQuiz } = useAsync(() => getQuizForAdmin(course.id), [course.id]);
  const { data: employees } = useAsync(() => listEmployees({ pageSize: 100 }), []);

  const categoryName = categories.find((c) => c.id === course.categoryId)?.name ?? '—';

  async function runAction(key: string, action: () => Promise<unknown>) {
    setBusy(key);
    setError(null);
    try {
      await action();
      onChanged();
      reloadDetail();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('error.generic'));
    } finally {
      setBusy(null);
    }
  }

  return (
    <details className="group" data-testid="course-admin-row">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-1 py-2.5 text-sm hover:bg-sand-50">
        <span className="text-ink-800">{course.title}</span>
        <span className="text-ink-500">{categoryName}</span>
        <span className="flex items-center gap-2">
          {course.isMandatory && <span className="text-xs text-coral-600">{t('lms.mandatory')}</span>}
          <StatusBadge status={course.status} label={t(`lms.course.status.${course.status}`)} />
        </span>
      </summary>

      <div className="space-y-5 border-t border-ink-100 px-1 py-3">
        {error && <Alert tone="error">{error}</Alert>}

        <div className="flex gap-2">
          {course.status === 'DRAFT' && (
            <Button size="sm" loading={busy === 'publish'} onClick={() => runAction('publish', () => publishCourse(course.id))} data-testid="publish-course-button">
              {t('lms.admin.publish')}
            </Button>
          )}
          {course.status !== 'ARCHIVED' && (
            <Button size="sm" variant="secondary" loading={busy === 'archive'} onClick={() => runAction('archive', () => archiveCourse(course.id))}>
              {t('lms.admin.archive')}
            </Button>
          )}
        </div>

        <section>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-400">{t('lms.admin.content')}</p>
          <ul className="mb-3 space-y-1.5">
            {(detail?.contentItems ?? []).map((item) => (
              <li key={item.id} className="flex items-center justify-between rounded-lg bg-sand-50 px-3 py-2 text-sm" data-testid="admin-content-item-row">
                <span className="text-ink-700">
                  {item.orderIndex + 1}. {item.title} <span className="text-ink-400">({t(`lms.content.type.${item.type}`)})</span>
                </span>
                <span className="flex items-center gap-2">
                  {item.storageKey && (
                    <Button variant="ghost" size="sm" onClick={() => downloadContentFile(course.id, item.id, item.title)}>
                      {t('lms.admin.uploadFile')}
                    </Button>
                  )}
                  {item.type !== 'LINK' && !item.storageKey && (
                    <input
                      type="file"
                      data-testid="content-file-input"
                      className="text-xs text-ink-500"
                      onChange={async (e) => {
                        const file = e.target.files?.[0];
                        if (!file) return;
                        setBusy(`upload-${item.id}`);
                        try {
                          await uploadContentFile(course.id, item.id, file);
                          reloadDetail();
                        } catch (err) {
                          setError(err instanceof ApiError ? err.message : t('error.generic'));
                        } finally {
                          setBusy(null);
                        }
                      }}
                    />
                  )}
                </span>
              </li>
            ))}
          </ul>
          <AddContentItemForm courseId={course.id} nextOrderIndex={detail?.contentItems.length ?? 0} onAdded={reloadDetail} />
        </section>

        <section>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-400">{t('lms.admin.quiz')}</p>
          <QuizAdminEditor courseId={course.id} quiz={quiz ?? null} onChanged={reloadQuiz} />
        </section>

        <section>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-400">{t('lms.admin.assignTraining')}</p>
          <AssignTrainingForm courseId={course.id} employees={employees?.data ?? []} onAssigned={onChanged} />
        </section>
      </div>
    </details>
  );
}

function AddContentItemForm({ courseId, nextOrderIndex, onAdded }: { courseId: string; nextOrderIndex: number; onAdded: () => void }) {
  const { t } = useI18n();
  const [moduleName, setModuleName] = useState('');
  const [type, setType] = useState<(typeof CONTENT_TYPES)[number]>('DOCUMENT');
  const [title, setTitle] = useState('');
  const [externalUrl, setExternalUrl] = useState('');
  const [durationMinutes, setDurationMinutes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await addContentItem(courseId, {
        moduleName: moduleName || undefined,
        orderIndex: nextOrderIndex,
        type,
        title,
        externalUrl: type === 'LINK' ? externalUrl : undefined,
        durationMinutes: durationMinutes ? Number(durationMinutes) : undefined,
      });
      setTitle('');
      setExternalUrl('');
      setDurationMinutes('');
      onAdded();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('error.generic'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-2 rounded-lg bg-sand-50 p-3" data-testid="add-content-item-form">
      <div>
        <Label htmlFor={`content-type-${courseId}`}>{t('lms.admin.contentType')}</Label>
        <Select id={`content-type-${courseId}`} value={type} onChange={(e) => setType(e.target.value as (typeof CONTENT_TYPES)[number])} className="w-32">
          {CONTENT_TYPES.map((ct) => (
            <option key={ct} value={ct}>
              {t(`lms.content.type.${ct}`)}
            </option>
          ))}
        </Select>
      </div>
      <div>
        <Label htmlFor={`content-title-${courseId}`}>{t('common.name')}</Label>
        <Input id={`content-title-${courseId}`} value={title} onChange={(e) => setTitle(e.target.value)} required data-testid="content-item-title-input" />
      </div>
      {type === 'LINK' && (
        <div>
          <Label htmlFor={`content-url-${courseId}`}>{t('lms.admin.externalUrl')}</Label>
          <Input id={`content-url-${courseId}`} type="url" value={externalUrl} onChange={(e) => setExternalUrl(e.target.value)} required />
        </div>
      )}
      <div>
        <Label htmlFor={`content-module-${courseId}`}>{t('lms.admin.moduleName')}</Label>
        <Input id={`content-module-${courseId}`} value={moduleName} onChange={(e) => setModuleName(e.target.value)} />
      </div>
      <div>
        <Label htmlFor={`content-duration-${courseId}`}>{t('lms.admin.durationMinutes')}</Label>
        <Input id={`content-duration-${courseId}`} type="number" min="0" value={durationMinutes} onChange={(e) => setDurationMinutes(e.target.value)} className="w-28" />
      </div>
      {error && <Alert tone="error">{error}</Alert>}
      <Button type="submit" size="sm" loading={submitting} data-testid="add-content-item-button">
        {t('lms.admin.addContent')}
      </Button>
    </form>
  );
}

function AssignTrainingForm({
  courseId,
  employees,
  onAssigned,
}: {
  courseId: string;
  employees: { id: string; firstName: string; lastName: string }[];
  onAssigned: () => void;
}) {
  const { t } = useI18n();
  const [employeeId, setEmployeeId] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    setSuccess(false);
    try {
      await assignCourse(courseId, { employeeId, dueDate: dueDate || undefined });
      setSuccess(true);
      setEmployeeId('');
      setDueDate('');
      onAssigned();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('error.generic'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-2 rounded-lg bg-sand-50 p-3" data-testid="assign-training-form">
      <div>
        <Label htmlFor={`assign-employee-${courseId}`}>{t('lms.admin.employee')}</Label>
        <Select id={`assign-employee-${courseId}`} value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} required className="w-56" data-testid="assign-training-employee-select">
          <option value="">—</option>
          {employees.map((e) => (
            <option key={e.id} value={e.id}>
              {e.firstName} {e.lastName}
            </option>
          ))}
        </Select>
      </div>
      <div>
        <Label htmlFor={`assign-due-${courseId}`}>{t('lms.admin.assign')}</Label>
        <Input id={`assign-due-${courseId}`} type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
      </div>
      {error && <Alert tone="error">{error}</Alert>}
      {success && <Alert tone="success">{t('lms.admin.assign')}</Alert>}
      <Button type="submit" size="sm" loading={submitting} disabled={!employeeId} data-testid="assign-training-button">
        {t('lms.admin.assign')}
      </Button>
    </form>
  );
}
