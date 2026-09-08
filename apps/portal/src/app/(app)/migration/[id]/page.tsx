'use client';

import { useState } from 'react';
import { useParams } from 'next/navigation';
import { RefreshCw } from 'lucide-react';
import { PERMISSIONS } from '@hrm/shared';
import { useI18n } from '../../../../i18n/I18nProvider';
import { useAuth } from '../../../../lib/auth/AuthContext';
import { useAsync } from '../../../../lib/useAsync';
import { ApiError } from '../../../../lib/api/client';
import { commitImportBatch, downloadImportErrorReport, getImportBatch, listImportRowErrors, validateImportBatch } from '../../../../lib/api/migration';
import { Card, CardBody, CardHeader, CardTitle } from '../../../../components/ui/Card';
import { Button } from '../../../../components/ui/Button';
import { Alert } from '../../../../components/ui/Alert';
import { PageSpinner } from '../../../../components/ui/Spinner';
import { StatusBadge } from '../../../../components/ui/Badge';
import { EmptyState } from '../../../../components/ui/EmptyState';

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-ink-400">{label}</p>
      <p className="text-2xl font-semibold text-ink-900">{value}</p>
    </div>
  );
}

export default function ImportBatchDetailPage() {
  const { t } = useI18n();
  const { can } = useAuth();
  const params = useParams<{ id: string }>();
  const canManage = can(PERMISSIONS.MIGRATION_MANAGE);

  const { data: batch, loading, error, reload } = useAsync(
    () => (canManage ? getImportBatch(params.id) : Promise.resolve(null)),
    [canManage, params.id],
  );
  const { data: rowErrors, reload: reloadErrors } = useAsync(
    () => (canManage ? listImportRowErrors(params.id) : Promise.resolve([])),
    [canManage, params.id],
  );

  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmingCommit, setConfirmingCommit] = useState(false);

  if (!canManage) return <Alert tone="info">{t('migration.noAccess')}</Alert>;
  if (loading && !batch) return <PageSpinner />;
  if (error || !batch) return <Alert tone="error">{error ?? 'Not found.'}</Alert>;

  async function runAction(fn: () => Promise<unknown>) {
    setActionError(null);
    setBusy(true);
    try {
      await fn();
      reload();
      reloadErrors();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : t('error.generic'));
    } finally {
      setBusy(false);
    }
  }

  const isProcessing = batch.status === 'VALIDATING' || batch.status === 'COMMITTING';

  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-semibold text-ink-900">{t(`migration.entityType.${batch.entityType}`)}</h1>
          <p className="text-sm text-ink-500">{batch.fileName}</p>
        </div>
        <StatusBadge status={batch.status} label={t(`migration.status.${batch.status}`)} />
      </div>

      {actionError && <Alert tone="error">{actionError}</Alert>}
      {batch.failureReason && <Alert tone="error">{batch.failureReason}</Alert>}
      {isProcessing && (
        <Alert tone="info">{batch.status === 'VALIDATING' ? t('migration.dryRun.running') : t('migration.commit.running')}</Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>{t('migration.dryRun.summary')}</CardTitle>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              reload();
              reloadErrors();
            }}
            data-testid="refresh-batch-button"
          >
            <RefreshCw className="h-4 w-4" aria-hidden />
            {t('migration.refresh')}
          </Button>
        </CardHeader>
        <CardBody className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat label={t('migration.dryRun.willCreate')} value={batch.createCount} />
          <Stat label={t('migration.dryRun.willUpdate')} value={batch.updateCount} />
          <Stat label={t('migration.dryRun.willSkip')} value={batch.skipCount} />
          <Stat label={t('migration.dryRun.rowErrors')} value={batch.errorCount} />
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('migration.dryRun.rowErrors')}</CardTitle>
          {batch.errorCount > 0 && (
            <Button variant="secondary" size="sm" onClick={() => downloadImportErrorReport(batch.id)} data-testid="download-error-report-button">
              {t('migration.report.download')}
            </Button>
          )}
        </CardHeader>
        <CardBody>
          {!rowErrors || rowErrors.length === 0 ? (
            <EmptyState title={t('migration.dryRun.noErrors')} />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-ink-100 text-left text-ink-500">
                    <th className="py-2 pr-4">#</th>
                    <th className="py-2 pr-4">{t('migration.history.errors')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rowErrors.map((rowError) => (
                    <tr key={rowError.id} data-testid="import-row-error" className="border-b border-ink-50">
                      <td className="py-2 pr-4 text-ink-500">{rowError.rowNumber}</td>
                      <td className="py-2 pr-4 text-ink-700">{rowError.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>

      <div className="flex justify-end gap-2">
        {(batch.status === 'UPLOADED' || batch.status === 'FAILED') && (
          <Button variant="secondary" loading={busy} onClick={() => runAction(() => validateImportBatch(batch.id))} data-testid="validate-batch-button">
            {t('migration.mapping.runDryRun')}
          </Button>
        )}
        {batch.status === 'DRY_RUN_COMPLETE' && !confirmingCommit && (
          <Button loading={busy} onClick={() => setConfirmingCommit(true)} data-testid="commit-batch-button">
            {t('migration.commit.button')}
          </Button>
        )}
        {confirmingCommit && (
          <div className="flex items-center gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
            <span>{t('migration.commit.confirm')}</span>
            <Button variant="secondary" size="sm" onClick={() => setConfirmingCommit(false)}>
              {t('action.cancel')}
            </Button>
            <Button
              size="sm"
              loading={busy}
              onClick={() => {
                setConfirmingCommit(false);
                runAction(() => commitImportBatch(batch.id));
              }}
              data-testid="confirm-commit-button"
            >
              {t('migration.commit.button')}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
