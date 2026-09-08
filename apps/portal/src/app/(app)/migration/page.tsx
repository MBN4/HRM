'use client';

import Link from 'next/link';
import { Plus, Upload } from 'lucide-react';
import { PERMISSIONS } from '@hrm/shared';
import { useI18n } from '../../../i18n/I18nProvider';
import { useAuth } from '../../../lib/auth/AuthContext';
import { useAsync } from '../../../lib/useAsync';
import { listImportBatches } from '../../../lib/api/migration';
import { Card, CardBody, CardHeader, CardTitle } from '../../../components/ui/Card';
import { Button } from '../../../components/ui/Button';
import { Alert } from '../../../components/ui/Alert';
import { EmptyState } from '../../../components/ui/EmptyState';
import { PageSpinner } from '../../../components/ui/Spinner';
import { StatusBadge } from '../../../components/ui/Badge';

export default function MigrationHistoryPage() {
  const { t } = useI18n();
  const { can } = useAuth();
  const canManage = can(PERMISSIONS.MIGRATION_MANAGE);
  const { data: batches, loading, error } = useAsync(() => (canManage ? listImportBatches() : Promise.resolve([])), [canManage]);

  if (!canManage) {
    return <Alert tone="info">{t('migration.noAccess')}</Alert>;
  }

  return (
    <div className="max-w-5xl space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-ink-900">{t('migration.title')}</h1>
          <p className="text-sm text-ink-500">{t('migration.subtitle')}</p>
        </div>
        <Link href="/migration/new">
          <Button data-testid="new-import-button">
            <Plus className="h-4 w-4" aria-hidden />
            {t('migration.newImport')}
          </Button>
        </Link>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('migration.history.title')}</CardTitle>
        </CardHeader>
        <CardBody>
          {loading ? (
            <PageSpinner />
          ) : error ? (
            <Alert tone="error">{error}</Alert>
          ) : !batches || batches.length === 0 ? (
            <EmptyState icon={Upload} title={t('migration.history.noBatches')} />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-ink-100 text-left text-ink-500">
                    <th className="py-2 pr-4">{t('migration.history.entityType')}</th>
                    <th className="py-2 pr-4">{t('migration.history.status')}</th>
                    <th className="py-2 pr-4">{t('migration.history.rows')}</th>
                    <th className="py-2 pr-4">{t('migration.history.created')}</th>
                    <th className="py-2 pr-4">{t('migration.history.updated')}</th>
                    <th className="py-2 pr-4">{t('migration.history.errors')}</th>
                    <th className="py-2 pr-4">{t('migration.history.startedAt')}</th>
                    <th className="py-2" />
                  </tr>
                </thead>
                <tbody>
                  {batches.map((batch) => (
                    <tr key={batch.id} data-testid="import-batch-row" className="border-b border-ink-50">
                      <td className="py-2 pr-4">{t(`migration.entityType.${batch.entityType}`)}</td>
                      <td className="py-2 pr-4">
                        <StatusBadge status={batch.status} label={t(`migration.status.${batch.status}`)} />
                      </td>
                      <td className="py-2 pr-4">{batch.totalRows}</td>
                      <td className="py-2 pr-4">{batch.createCount}</td>
                      <td className="py-2 pr-4">{batch.updateCount}</td>
                      <td className="py-2 pr-4">{batch.errorCount}</td>
                      <td className="py-2 pr-4">{new Date(batch.createdAt).toLocaleString()}</td>
                      <td className="py-2">
                        <Link href={`/migration/${batch.id}`} className="text-brand-600 hover:underline" data-testid="view-import-batch-link">
                          {t('migration.history.view')}
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
