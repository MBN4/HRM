'use client';

import { useState } from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import { useAsync } from '../../lib/useAsync';
import { listAssignmentsForAsset, listMaintenanceForAsset, returnAsset } from '../../lib/api/assets';
import { ApiError } from '../../lib/api/client';
import { formatDate } from '../../lib/format';
import type { Asset, AssetCategory } from '../../lib/api/types';
import { StatusBadge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Modal } from '../ui/Modal';
import { Alert } from '../ui/Alert';
import { AssignAssetForm } from './AssignAssetForm';

export function AssetRow({
  asset,
  categories,
  locale,
  onChanged,
}: {
  asset: Asset;
  categories: AssetCategory[];
  locale: string;
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const [assigning, setAssigning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: assignments, reload: reloadAssignments } = useAsync(() => listAssignmentsForAsset(asset.id), [asset.id]);
  const { data: maintenance } = useAsync(() => listMaintenanceForAsset(asset.id), [asset.id]);
  const currentAssignment = assignments?.find((a) => a.status === 'ASSIGNED');

  async function handleReturn() {
    if (!currentAssignment) return;
    setBusy(true);
    setError(null);
    try {
      await returnAsset(currentAssignment.id);
      reloadAssignments();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('error.generic'));
    } finally {
      setBusy(false);
    }
  }

  function categoryName(categoryId: string): string {
    return categories.find((c) => c.id === categoryId)?.name ?? categoryId.slice(0, 8);
  }

  return (
    <details className="group" data-testid="asset-row">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-1 py-2.5 text-sm hover:bg-sand-50">
        <span className="text-ink-800">
          {asset.name} <span className="text-ink-400">({asset.assetTag})</span>
        </span>
        <span className="text-ink-500">{categoryName(asset.categoryId)}</span>
        <StatusBadge status={asset.status} label={t(`assets.status.${asset.status}`)} />
      </summary>
      <div className="space-y-3 border-t border-ink-100 px-1 py-3">
        {error && <Alert tone="error">{error}</Alert>}

        <div className="flex items-center justify-between">
          <p className="text-xs text-ink-500">
            {maintenance && maintenance.length > 0
              ? `${t('assets.admin.maintenance')}: ${maintenance.length}`
              : t('common.noData')}
          </p>
          {asset.status === 'AVAILABLE' && (
            <Button size="sm" data-testid="assign-asset-button" onClick={() => setAssigning(true)}>
              {t('assets.admin.assign')}
            </Button>
          )}
          {asset.status === 'ASSIGNED' && currentAssignment && (
            <Button size="sm" variant="secondary" loading={busy} data-testid="return-asset-button" onClick={handleReturn}>
              {t('assets.admin.return')}
            </Button>
          )}
        </div>

        {assignments && assignments.length > 0 && (
          <table className="w-full text-start text-sm">
            <thead>
              <tr className="text-xs uppercase tracking-wide text-ink-400">
                <th className="py-1 text-start font-medium">{t('assets.assignedAt')}</th>
                <th className="py-1 text-start font-medium">{t('assets.returnedAt')}</th>
                <th className="py-1 text-start font-medium">{t('common.status')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {assignments.map((a) => (
                <tr key={a.id}>
                  <td className="py-1.5 text-ink-700">{formatDate(a.assignedAt, locale)}</td>
                  <td className="py-1.5 text-ink-700">{formatDate(a.returnedAt, locale)}</td>
                  <td className="py-1.5">
                    <StatusBadge status={a.status} label={t(`assets.assignmentStatus.${a.status}`)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {assigning && (
        <Modal title={t('assets.admin.assign')} onClose={() => setAssigning(false)}>
          <AssignAssetForm
            assetId={asset.id}
            onCancel={() => setAssigning(false)}
            onSaved={() => {
              setAssigning(false);
              reloadAssignments();
              onChanged();
            }}
          />
        </Modal>
      )}
    </details>
  );
}
