'use client';

import { FormEvent, useState } from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import { createCourse } from '../../lib/api/lms';
import { ApiError } from '../../lib/api/client';
import type { CourseCategory } from '../../lib/api/types';
import { Button } from '../ui/Button';
import { Input, Label, Select, Textarea } from '../ui/Field';
import { Alert } from '../ui/Alert';

export function NewCourseForm({ categories, onSaved, onCancel }: { categories: CourseCategory[]; onSaved: () => void; onCancel: () => void }) {
  const { t } = useI18n();
  const [categoryId, setCategoryId] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [isMandatory, setIsMandatory] = useState(false);
  const [validityMonths, setValidityMonths] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await createCourse({
        categoryId: categoryId || undefined,
        title,
        description: description || undefined,
        isMandatory,
        validityMonths: validityMonths ? Number(validityMonths) : undefined,
      });
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
        <Label htmlFor="new-course-title">{t('common.name')}</Label>
        <Input id="new-course-title" value={title} onChange={(e) => setTitle(e.target.value)} required data-testid="new-course-title-input" />
      </div>
      <div>
        <Label htmlFor="new-course-description">
          {t('lms.admin.description')} <span className="text-ink-400">({t('common.optional')})</span>
        </Label>
        <Textarea id="new-course-description" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>
      <div>
        <Label htmlFor="new-course-category">
          {t('lms.admin.categories')} <span className="text-ink-400">({t('common.optional')})</span>
        </Label>
        <Select id="new-course-category" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
          <option value="">—</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      </div>
      <div>
        <Label htmlFor="new-course-validity">
          {t('lms.admin.validityMonths')} <span className="text-ink-400">({t('common.optional')})</span>
        </Label>
        <Input id="new-course-validity" type="number" min="1" value={validityMonths} onChange={(e) => setValidityMonths(e.target.value)} className="w-32" />
      </div>
      <label className="flex items-center gap-2 text-sm text-ink-700">
        <input type="checkbox" checked={isMandatory} onChange={(e) => setIsMandatory(e.target.checked)} />
        {t('lms.mandatory')}
      </label>

      {error && <Alert tone="error">{error}</Alert>}

      <div className="flex justify-end gap-2 border-t border-ink-100 pt-4">
        <Button type="button" variant="secondary" onClick={onCancel}>
          {t('action.cancel')}
        </Button>
        <Button type="submit" loading={submitting} data-testid="submit-new-course-button">
          {t('action.save')}
        </Button>
      </div>
    </form>
  );
}
