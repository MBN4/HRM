'use client';

import { PERMISSIONS } from '@hrm/shared';
import { useI18n } from '../../../i18n/I18nProvider';
import { useAuth } from '../../../lib/auth/AuthContext';
import { useAsync } from '../../../lib/useAsync';
import { listAssetCategories, listMyAssignments } from '../../../lib/api/assets';
import { formatDate } from '../../../lib/format';
import { Card, CardBody, CardHeader, CardTitle } from '../../../components/ui/Card';
import { Alert } from '../../../components/ui/Alert';
import { StatusBadge } from '../../../components/ui/Badge';
import { EmptyState } from '../../../components/ui/EmptyState';
import { PageSpinner } from '../../../components/ui/Spinner';

export default function AssetsPage() {
  const { t, locale } = useI18n();
  const { can } = useAuth();

  const canView = can(PERMISSIONS.ASSET_READ);
  const { data: categories } = useAsync(() => (canView ? listAssetCategories() : Promise.resolve([])), [canView]);
  const { data: assignments, loading } = useAsync(() => (canView ? listMyAssignments() : Promise.resolve([])), [canView]);

  if (!canView) {
    return <Alert tone="info">{t('error.forbidden')}</Alert>;
  }

  function categoryName(categoryId: string | undefined): string {
    return categories?.find((c) => c.id === categoryId)?.name ?? '';
  }

  return (
    <div className="max-w-3xl space-y-6">
      <h1 className="text-xl font-semibold text-ink-900">{t('assets.title')}</h1>

      <Card>
        <CardHeader>
          <CardTitle>{t('assets.myAssets')}</CardTitle>
        </CardHeader>
        <CardBody>
          {loading ? (
            <PageSpinner />
          ) : !assignments || assignments.length === 0 ? (
            <EmptyState title={t('assets.noAssets')} />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-start text-sm">
                <thead>
                  <tr className="border-b border-ink-100 text-xs uppercase tracking-wide text-ink-400">
                    <th className="py-2 text-start font-medium">{t('assets.name')}</th>
                    <th className="py-2 text-start font-medium">{t('assets.admin.category')}</th>
                    <th className="py-2 text-start font-medium">{t('assets.assignedAt')}</th>
                    <th className="py-2 text-start font-medium">{t('common.status')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {assignments.map((a) => (
                    <tr key={a.id} data-testid="my-asset-row">
                      <td className="py-2.5 text-ink-800">
                        {a.asset?.name ?? a.assetId} <span className="text-ink-400">({a.asset?.assetTag})</span>
                      </td>
                      <td className="py-2.5 text-ink-600">{categoryName(a.asset?.categoryId)}</td>
                      <td className="py-2.5 text-ink-600">{formatDate(a.assignedAt, locale)}</td>
                      <td className="py-2.5">
                        <StatusBadge status={a.status} label={t(`assets.assignmentStatus.${a.status}`)} />
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
