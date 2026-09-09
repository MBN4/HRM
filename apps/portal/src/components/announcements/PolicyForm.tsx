'use client';

import { FormEvent, useState } from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import { createPolicy } from '../../lib/api/announcements';
import { ApiError } from '../../lib/api/client';
import { Button } from '../ui/Button';
import { Input, Label, Textarea } from '../ui/Field';
import { Alert } from '../ui/Alert';

export function PolicyForm({ onSubmitted, onCancel }: { onSubmitted: () => void; onCancel: () => void }) {
  const { t } = useI18n();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [requiresAcknowledgment, setRequiresAcknowledgment] = useState(true);
  const [requiresSignature, setRequiresSignature] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await createPolicy({ title, body, requiresAcknowledgment, requiresSignature, publish: true });
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
        <Label htmlFor="policy-title">{t('common.name')}</Label>
        <Input id="policy-title" value={title} onChange={(e) => setTitle(e.target.value)} required />
      </div>
      <div>
        <Label htmlFor="policy-body">{t('expenses.description')}</Label>
        <Textarea id="policy-body" rows={6} value={body} onChange={(e) => setBody(e.target.value)} required />
      </div>
      <label className="flex items-center gap-2 text-sm text-ink-700">
        <input type="checkbox" checked={requiresAcknowledgment} onChange={(e) => setRequiresAcknowledgment(e.target.checked)} />
        {t('policies.acknowledge')}
      </label>
      <label className="flex items-center gap-2 text-sm text-ink-700">
        <input
          type="checkbox"
          checked={requiresSignature}
          onChange={(e) => setRequiresSignature(e.target.checked)}
          data-testid="policy-requires-signature-checkbox"
        />
        {t('policies.requiresSignature')}
      </label>

      {error && <Alert tone="error">{error}</Alert>}

      <div className="flex justify-end gap-2 border-t border-ink-100 pt-4">
        <Button type="button" variant="secondary" onClick={onCancel}>
          {t('action.cancel')}
        </Button>
        <Button type="submit" loading={submitting}>
          {t('policies.admin.publish')}
        </Button>
      </div>
    </form>
  );
}
