'use client';

import { FormEvent, useState } from 'react';
import { Plus } from 'lucide-react';
import { useI18n } from '../../i18n/I18nProvider';
import { useAsync } from '../../lib/useAsync';
import { ApiError } from '../../lib/api/client';
import { createRecognitionCategory, listRecognitionCategories, updateRecognitionCategory } from '../../lib/api/engagement';
import type { RecognitionCategory } from '../../lib/api/types';
import { Alert } from '../ui/Alert';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Card, CardBody, CardHeader, CardTitle } from '../ui/Card';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { EmptyState } from '../ui/EmptyState';
import { Input, Label, Textarea } from '../ui/Field';
import { Modal } from '../ui/Modal';
import { PageSpinner } from '../ui/Spinner';

function CategoryForm({ category, onSaved, onCancel }: { category: RecognitionCategory | null; onSaved: () => void; onCancel: () => void }) {
  const { t } = useI18n();
  const [name, setName] = useState(category?.name ?? '');
  const [description, setDescription] = useState(category?.description ?? '');
  const [points, setPoints] = useState(String(category?.points ?? 1));
  const [isActive, setIsActive] = useState(category?.isActive ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    const body = { name: name.trim(), description: description.trim() || undefined, points: Number(points), isActive };
    try {
      if (category) await updateRecognitionCategory(category.id, body);
      else await createRecognitionCategory(body);
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('error.generic'));
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div>
        <Label htmlFor="category-name">{t('common.name')}</Label>
        <Input id="category-name" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} required />
      </div>
      <div>
        <Label htmlFor="category-description">
          {t('engagement.categories.description')} ({t('common.optional')})
        </Label>
        <Textarea id="category-description" rows={2} maxLength={300} value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>
      <div>
        <Label htmlFor="category-points">{t('engagement.categories.points')}</Label>
        <Input id="category-points" type="number" min={0} max={100} step={1} value={points} onChange={(e) => setPoints(e.target.value)} required />
      </div>
      <label className="flex items-center gap-2 text-sm text-ink-800">
        <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
        {t('engagement.categories.active')}
      </label>
      {error && <Alert tone="error">{error}</Alert>}
      <div className="flex justify-end gap-2 border-t border-ink-100 pt-4">
        <Button type="button" variant="secondary" onClick={onCancel}>
          {t('action.cancel')}
        </Button>
        <Button type="submit" loading={saving} data-testid="save-category-button">
          {t('action.save')}
        </Button>
      </div>
    </form>
  );
}

/** Recognition categories ("values"): add / edit / deactivate. Categories are never deleted — past recognitions reference them. */
export function CategoryAdmin() {
  const { t } = useI18n();
  const { data, loading, error, reload } = useAsync(() => listRecognitionCategories(true), []);
  const [editing, setEditing] = useState<RecognitionCategory | 'new' | null>(null);
  const [toggling, setToggling] = useState<RecognitionCategory | null>(null);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('engagement.categories.title')}</CardTitle>
        <Button size="sm" onClick={() => setEditing('new')} data-testid="new-category-button">
          <Plus className="h-4 w-4" aria-hidden />
          {t('engagement.categories.new')}
        </Button>
      </CardHeader>
      <CardBody>
        {loading ? (
          <PageSpinner />
        ) : error ? (
          <Alert tone="error">{error}</Alert>
        ) : !data || data.length === 0 ? (
          <EmptyState title={t('engagement.categories.empty')} />
        ) : (
          <ul className="divide-y divide-ink-100" data-testid="category-list">
            {data.map((c) => (
              <li key={c.id} data-testid="category-row" className="flex flex-wrap items-center gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-ink-900">{c.name}</p>
                  {c.description && <p className="text-xs text-ink-500">{c.description}</p>}
                </div>
                <span className="text-sm text-ink-600">{t('recognition.points', { count: c.points })}</span>
                <Badge tone={c.isActive ? 'success' : 'neutral'}>{c.isActive ? t('engagement.categories.statusActive') : t('engagement.categories.statusInactive')}</Badge>
                <Button size="sm" variant="secondary" onClick={() => setEditing(c)}>
                  {t('action.edit')}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setToggling(c)} data-testid="toggle-category-button">
                  {c.isActive ? t('engagement.categories.deactivate') : t('engagement.categories.reactivate')}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
      {editing && (
        <Modal title={editing === 'new' ? t('engagement.categories.new') : t('engagement.categories.edit')} onClose={() => setEditing(null)}>
          <CategoryForm
            category={editing === 'new' ? null : editing}
            onCancel={() => setEditing(null)}
            onSaved={() => {
              setEditing(null);
              reload();
            }}
          />
        </Modal>
      )}
      {toggling && (
        <ConfirmDialog
          title={toggling.isActive ? t('engagement.categories.deactivate') : t('engagement.categories.reactivate')}
          body={toggling.isActive ? t('engagement.categories.deactivateBody', { name: toggling.name }) : t('engagement.categories.reactivateBody', { name: toggling.name })}
          confirmLabel={toggling.isActive ? t('engagement.categories.deactivate') : t('engagement.categories.reactivate')}
          tone={toggling.isActive ? 'danger' : 'primary'}
          onClose={() => setToggling(null)}
          onConfirm={async () => {
            await updateRecognitionCategory(toggling.id, { name: toggling.name, description: toggling.description ?? undefined, points: toggling.points, isActive: !toggling.isActive });
            setToggling(null);
            reload();
          }}
        />
      )}
    </Card>
  );
}
