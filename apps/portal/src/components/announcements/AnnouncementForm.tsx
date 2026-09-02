'use client';

import { FormEvent, useState } from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import { createAnnouncement } from '../../lib/api/announcements';
import { ApiError } from '../../lib/api/client';
import { useAsync } from '../../lib/useAsync';
import { listBranches } from '../../lib/api/tenancy';
import { Button } from '../ui/Button';
import { Input, Label, Textarea } from '../ui/Field';
import { Alert } from '../ui/Alert';

export function AnnouncementForm({ onSubmitted, onCancel }: { onSubmitted: () => void; onCancel: () => void }) {
  const { t } = useI18n();
  const { data: branches } = useAsync(() => listBranches(), []);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [targetBranchIds, setTargetBranchIds] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggleBranch(id: string) {
    setTargetBranchIds((current) => (current.includes(id) ? current.filter((b) => b !== id) : [...current, id]));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await createAnnouncement({ title, body, targetBranchIds, publish: true });
      onSubmitted();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('error.generic'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <Label htmlFor="announcement-title">{t('common.name')}</Label>
        <Input id="announcement-title" value={title} onChange={(e) => setTitle(e.target.value)} required />
      </div>
      <div>
        <Label htmlFor="announcement-body">{t('expenses.description')}</Label>
        <Textarea id="announcement-body" rows={4} value={body} onChange={(e) => setBody(e.target.value)} required />
      </div>
      <div>
        <Label>{t('announcements.admin.targetBranches')}</Label>
        {!branches || branches.length === 0 ? (
          <p className="text-sm text-ink-400">{t('common.noData')}</p>
        ) : (
          <div className="space-y-1">
            <p className="text-xs text-ink-400">{t('announcements.admin.allBranches')}</p>
            {branches.map((b) => (
              <label key={b.id} className="flex items-center gap-2 text-sm text-ink-700">
                <input type="checkbox" checked={targetBranchIds.includes(b.id)} onChange={() => toggleBranch(b.id)} />
                {b.name}
              </label>
            ))}
          </div>
        )}
      </div>

      {error && <Alert tone="error">{error}</Alert>}

      <div className="flex justify-end gap-2 border-t border-ink-100 pt-4">
        <Button type="button" variant="secondary" onClick={onCancel}>
          {t('action.cancel')}
        </Button>
        <Button type="submit" loading={submitting}>
          {t('announcements.admin.publish')}
        </Button>
      </div>
    </form>
  );
}
