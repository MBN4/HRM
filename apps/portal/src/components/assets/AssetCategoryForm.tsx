'use client';

import { FormEvent, useState } from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import { upsertAssetCategory } from '../../lib/api/assets';
import { ApiError } from '../../lib/api/client';
import { Button } from '../ui/Button';
import { Input, Label } from '../ui/Field';
import { Alert } from '../ui/Alert';

export function AssetCategoryForm({ onSaved, onCancel }: { onSaved: () => void; onCancel: () => void }) {
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
      await upsertAssetCategory({ code, name });
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
        <Label htmlFor="asset-category-code">{t('expenses.admin.code')}</Label>
        <Input id="asset-category-code" value={code} onChange={(e) => setCode(e.target.value)} required />
      </div>
      <div>
        <Label htmlFor="asset-category-name">{t('expenses.admin.name')}</Label>
        <Input id="asset-category-name" value={name} onChange={(e) => setName(e.target.value)} required />
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
