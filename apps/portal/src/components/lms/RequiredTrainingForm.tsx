'use client';

import { FormEvent, useState } from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import { createRequiredTraining } from '../../lib/api/lms';
import { ApiError } from '../../lib/api/client';
import type { Branch, Course } from '../../lib/api/types';
import { Button } from '../ui/Button';
import { Label, Select } from '../ui/Field';
import { Alert } from '../ui/Alert';

/**
 * No role targeting in this form — this codebase has no `GET /roles`
 * listing endpoint anywhere (auth-rbac.md documents role management as
 * "enforcement + seeding only, no admin route yet"), the same documented-
 * gap posture frontend-admin-console.md already takes for missing
 * department pickers. Branch targeting alone still covers the common case.
 */
export function RequiredTrainingForm({
  courses,
  branches,
  onSaved,
  onCancel,
}: {
  courses: Course[];
  branches: Branch[];
  onSaved: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const [courseId, setCourseId] = useState(courses[0]?.id ?? '');
  const [branchId, setBranchId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await createRequiredTraining({ courseId, branchId: branchId || undefined });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('error.generic'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <Label htmlFor="required-training-course">{t('lms.admin.course')}</Label>
        <Select id="required-training-course" value={courseId} onChange={(e) => setCourseId(e.target.value)} required>
          {courses.map((c) => (
            <option key={c.id} value={c.id}>
              {c.title}
            </option>
          ))}
        </Select>
      </div>
      <div>
        <Label htmlFor="required-training-branch">{t('lms.admin.branch')}</Label>
        <Select id="required-training-branch" value={branchId} onChange={(e) => setBranchId(e.target.value)}>
          <option value="">—</option>
          {branches.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </Select>
      </div>

      {error && <Alert tone="error">{error}</Alert>}

      <div className="flex justify-end gap-2 border-t border-ink-100 pt-4">
        <Button type="button" variant="secondary" onClick={onCancel}>
          {t('action.cancel')}
        </Button>
        <Button type="submit" loading={submitting} disabled={!courseId} data-testid="submit-required-training-button">
          {t('action.save')}
        </Button>
      </div>
    </form>
  );
}
