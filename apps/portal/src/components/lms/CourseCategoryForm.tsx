'use client';

import { FormEvent, useState } from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import { upsertCourseCategory } from '../../lib/api/lms';
import { ApiError } from '../../lib/api/client';
import { Button } from '../ui/Button';
import { Input, Label } from '../ui/Field';
import { Alert } from '../ui/Alert';

export function CourseCategoryForm({ onSaved, onCancel }: { onSaved: () => void; onCancel: () => void }) {
  const { t } = useI18n();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await upsertCourseCategory({ code, name });
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
        <Label htmlFor="course-category-code">{t('expenses.admin.code')}</Label>
        <Input id="course-category-code" value={code} onChange={(e) => setCode(e.target.value)} required />
      </div>
      <div>
        <Label htmlFor="course-category-name">{t('expenses.admin.name')}</Label>
        <Input id="course-category-name" value={name} onChange={(e) => setName(e.target.value)} required />
      </div>

      {error && <Alert tone="error">{error}</Alert>}

      <div className="flex justify-end gap-2 border-t border-ink-100 pt-4">
        <Button type="button" variant="secondary" onClick={onCancel}>
          {t('action.cancel')}
        </Button>
        <Button type="submit" loading={submitting}>
          {t('action.save')}
        </Button>
      </div>
    </form>
  );
}
