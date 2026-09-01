'use client';

import { FormEvent, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { useI18n } from '../../i18n/I18nProvider';
import { upsertRatingScale } from '../../lib/api/performance';
import { ApiError } from '../../lib/api/client';
import { Button } from '../ui/Button';
import { Input, Label } from '../ui/Field';
import { Alert } from '../ui/Alert';
import type { RatingLevel, RatingScale } from '../../lib/api/types';

interface LevelRow {
  value: string;
  label: string;
  description: string;
}

const EMPTY_ROW: LevelRow = { value: '', label: '', description: '' };

/**
 * A minimal "manage rating scales" form — a cycle needs a `ratingScaleKey`
 * to exist before it can be created at all, and there is no dedicated
 * rating-scale management screen in this stage's scope. Deliberately tiny:
 * key + name + a dynamic list of level rows (value/label/optional
 * description), matching `RatingLevel`/`createRatingScaleSchema` exactly
 * (see packages/shared/src/validators/performance.validator.ts — at least
 * two levels, unique values).
 */
export function RatingScaleForm({ onCreated, onCancel }: { onCreated: (scale: RatingScale) => void; onCancel: () => void }) {
  const { t } = useI18n();
  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [levels, setLevels] = useState<LevelRow[]>([{ ...EMPTY_ROW }, { ...EMPTY_ROW }]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function updateLevel(index: number, patch: Partial<LevelRow>) {
    setLevels((rows) => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  function addLevel() {
    setLevels((rows) => [...rows, { ...EMPTY_ROW }]);
  }

  function removeLevel(index: number) {
    setLevels((rows) => rows.filter((_, i) => i !== index));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const parsedLevels: RatingLevel[] = levels.map((row) => ({
        value: Number(row.value),
        label: row.label,
        ...(row.description ? { description: row.description } : {}),
      }));
      const scale = await upsertRatingScale({ key, name, levels: parsedLevels });
      onCreated(scale);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('error.generic'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <Label htmlFor="rating-scale-key">{t('performance.ratingScaleKey')}</Label>
        <Input id="rating-scale-key" value={key} onChange={(e) => setKey(e.target.value)} required />
      </div>
      <div>
        <Label htmlFor="rating-scale-name">{t('common.name')}</Label>
        <Input id="rating-scale-name" value={name} onChange={(e) => setName(e.target.value)} required />
      </div>

      <div>
        <Label>{t('performance.levels')}</Label>
        <div className="space-y-2">
          {levels.map((row, index) => (
            <div key={index} className="flex items-center gap-2" data-testid="rating-level-row">
              <Input
                aria-label={t('performance.levelValue')}
                placeholder={t('performance.levelValue')}
                type="number"
                className="w-24"
                value={row.value}
                onChange={(e) => updateLevel(index, { value: e.target.value })}
                required
              />
              <Input
                aria-label={t('performance.levelLabel')}
                placeholder={t('performance.levelLabel')}
                value={row.label}
                onChange={(e) => updateLevel(index, { label: e.target.value })}
                required
              />
              <Input
                aria-label={t('performance.levelDescription')}
                placeholder={`${t('performance.levelDescription')} (${t('common.optional')})`}
                value={row.description}
                onChange={(e) => updateLevel(index, { description: e.target.value })}
              />
              <button
                type="button"
                onClick={() => removeLevel(index)}
                disabled={levels.length <= 2}
                className="rounded-md p-1.5 text-ink-400 hover:bg-ink-100 hover:text-coral-600 disabled:cursor-not-allowed disabled:opacity-40"
                aria-label={t('common.remove')}
              >
                <Trash2 className="h-4 w-4" aria-hidden />
              </button>
            </div>
          ))}
        </div>
        <Button type="button" variant="secondary" size="sm" className="mt-2" onClick={addLevel}>
          {t('performance.addLevel')}
        </Button>
      </div>

      {error && <Alert tone="error">{error}</Alert>}

      <div className="flex justify-end gap-2 border-t border-ink-100 pt-4">
        <Button type="button" variant="secondary" onClick={onCancel}>
          {t('action.cancel')}
        </Button>
        <Button type="submit" loading={submitting} data-testid="submit-new-rating-scale-button">
          {t('action.save')}
        </Button>
      </div>
    </form>
  );
}
