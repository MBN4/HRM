'use client';

import { FormEvent, useState } from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import { useAsync } from '../../lib/useAsync';
import { createJobPosting, listJobRequisitions } from '../../lib/api/recruitment';
import { ApiError } from '../../lib/api/client';
import { Button } from '../ui/Button';
import { Input, Label, Select, Textarea } from '../ui/Field';
import { Alert } from '../ui/Alert';
import type { JobPosting } from '../../lib/api/types';

/** `requisitionId` is populated ONLY from `APPROVED` requisitions — `JobPostingService.create` requires it (see docs/conventions/recruitment-lifecycle.md). */
export function CreatePostingForm({ onCreated, onCancel }: { onCreated: (posting: JobPosting) => void; onCancel: () => void }) {
  const { t } = useI18n();
  const { data: approvedRequisitions } = useAsync(() => listJobRequisitions({ status: 'APPROVED' }), []);
  const [requisitionId, setRequisitionId] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [publicSlug, setPublicSlug] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!requisitionId) return;
    setSubmitting(true);
    setError(null);
    try {
      const posting = await createJobPosting({ requisitionId, title, description, publicSlug });
      onCreated(posting);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('error.generic'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <Label htmlFor="posting-requisition">{t('recruitment.requisition')}</Label>
        <Select id="posting-requisition" value={requisitionId} onChange={(e) => setRequisitionId(e.target.value)} required>
          <option value="" disabled>
            {t('recruitment.requisition')}
          </option>
          {(approvedRequisitions ?? []).map((r) => (
            <option key={r.id} value={r.id}>
              {r.title}
            </option>
          ))}
        </Select>
        {(approvedRequisitions ?? []).length === 0 && <Alert tone="info">{t('recruitment.noRequisitions')}</Alert>}
      </div>
      <div>
        <Label htmlFor="posting-title">{t('recruitment.title')}</Label>
        <Input id="posting-title" value={title} onChange={(e) => setTitle(e.target.value)} required />
      </div>
      <div>
        <Label htmlFor="posting-description">{t('recruitment.description')}</Label>
        <Textarea id="posting-description" rows={4} value={description} onChange={(e) => setDescription(e.target.value)} required />
      </div>
      <div>
        <Label htmlFor="posting-slug">{t('recruitment.publicSlug')}</Label>
        <Input id="posting-slug" value={publicSlug} onChange={(e) => setPublicSlug(e.target.value)} placeholder="senior-engineer" required />
      </div>

      {error && <Alert tone="error">{error}</Alert>}

      <div className="flex justify-end gap-2 border-t border-ink-100 pt-4">
        <Button type="button" variant="secondary" onClick={onCancel}>
          {t('action.cancel')}
        </Button>
        <Button type="submit" loading={submitting} disabled={!requisitionId} data-testid="submit-new-posting-button">
          {t('action.save')}
        </Button>
      </div>
    </form>
  );
}
