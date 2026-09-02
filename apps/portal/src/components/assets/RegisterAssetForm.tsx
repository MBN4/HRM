'use client';

import { FormEvent, useState } from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import { registerAsset } from '../../lib/api/assets';
import { ApiError } from '../../lib/api/client';
import type { AssetCategory } from '../../lib/api/types';
import { Button } from '../ui/Button';
import { Input, Label, Select } from '../ui/Field';
import { Alert } from '../ui/Alert';

export function RegisterAssetForm({ categories, onSaved, onCancel }: { categories: AssetCategory[]; onSaved: () => void; onCancel: () => void }) {
  const { t } = useI18n();
  const [categoryId, setCategoryId] = useState(categories[0]?.id ?? '');
  const [assetTag, setAssetTag] = useState('');
  const [name, setName] = useState('');
  const [serialNumber, setSerialNumber] = useState('');
  const [purchaseCost, setPurchaseCost] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await registerAsset({
        categoryId,
        assetTag,
        name,
        serialNumber: serialNumber || undefined,
        purchaseCost: purchaseCost ? Number(purchaseCost) : undefined,
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
        <Label htmlFor="asset-category">{t('assets.admin.category')}</Label>
        <Select id="asset-category" value={categoryId} onChange={(e) => setCategoryId(e.target.value)} required>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      </div>
      <div>
        <Label htmlFor="asset-tag">{t('assets.assetTag')}</Label>
        <Input id="asset-tag" value={assetTag} onChange={(e) => setAssetTag(e.target.value)} required />
      </div>
      <div>
        <Label htmlFor="asset-name">{t('assets.name')}</Label>
        <Input id="asset-name" value={name} onChange={(e) => setName(e.target.value)} required />
      </div>
      <div>
        <Label htmlFor="asset-serial">
          {t('assets.admin.serialNumber')} <span className="text-ink-400">({t('common.optional')})</span>
        </Label>
        <Input id="asset-serial" value={serialNumber} onChange={(e) => setSerialNumber(e.target.value)} />
      </div>
      <div>
        <Label htmlFor="asset-cost">
          {t('assets.admin.purchaseCost')} <span className="text-ink-400">({t('common.optional')})</span>
        </Label>
        <Input id="asset-cost" type="number" min="0" step="0.01" value={purchaseCost} onChange={(e) => setPurchaseCost(e.target.value)} />
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
