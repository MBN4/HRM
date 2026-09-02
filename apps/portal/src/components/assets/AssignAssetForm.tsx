'use client';

import { FormEvent, useState } from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import { assignAsset } from '../../lib/api/assets';
import { ApiError } from '../../lib/api/client';
import { useAsync } from '../../lib/useAsync';
import { listEmployees } from '../../lib/api/employees';
import { Button } from '../ui/Button';
import { Label, Select, Textarea } from '../ui/Field';
import { Alert } from '../ui/Alert';

export function AssignAssetForm({ assetId, onSaved, onCancel }: { assetId: string; onSaved: () => void; onCancel: () => void }) {
  const { t } = useI18n();
  const { data: employees } = useAsync(() => listEmployees({ pageSize: 100 }), []);
  const [employeeId, setEmployeeId] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await assignAsset({ assetId, employeeId, notes: notes || undefined });
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
        <Label htmlFor="assign-employee">{t('assets.admin.employee')}</Label>
        <Select id="assign-employee" value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} required>
          <option value="">—</option>
          {(employees?.data ?? []).map((e) => (
            <option key={e.id} value={e.id}>
              {e.firstName} {e.lastName}
            </option>
          ))}
        </Select>
      </div>
      <div>
        <Label htmlFor="assign-notes">
          {t('common.reason')} <span className="text-ink-400">({t('common.optional')})</span>
        </Label>
        <Textarea id="assign-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>

      {error && <Alert tone="error">{error}</Alert>}

      <div className="flex justify-end gap-2 border-t border-ink-100 pt-4">
        <Button type="button" variant="secondary" onClick={onCancel}>
          {t('action.cancel')}
        </Button>
        <Button type="submit" loading={submitting} disabled={!employeeId} data-testid="submit-assign-asset-button">
          {t('assets.admin.assign')}
        </Button>
      </div>
    </form>
  );
}
