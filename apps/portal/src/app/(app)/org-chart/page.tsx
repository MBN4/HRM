'use client';

import { useI18n } from '../../../i18n/I18nProvider';
import { useAsync } from '../../../lib/useAsync';
import { getOrgChart } from '../../../lib/api/employees';
import type { OrgChartNode } from '../../../lib/api/types';
import { Card, CardBody } from '../../../components/ui/Card';
import { EmptyState } from '../../../components/ui/EmptyState';
import { PageSpinner } from '../../../components/ui/Spinner';

function OrgNode({ node }: { node: OrgChartNode }) {
  return (
    <li>
      <div className="flex items-center gap-3 rounded-lg border border-ink-100 bg-white px-3 py-2">
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-100 text-xs font-semibold text-brand-800">
          {node.firstName.slice(0, 1)}
          {node.lastName.slice(0, 1)}
        </span>
        <p className="text-sm font-medium text-ink-900">
          {node.firstName} {node.lastName}
        </p>
      </div>
      {node.directReports.length > 0 && (
        <ul className="ms-6 mt-2 space-y-2 border-s border-ink-100 ps-4">
          {node.directReports.map((child) => (
            <OrgNode key={child.id} node={child} />
          ))}
        </ul>
      )}
    </li>
  );
}

export default function OrgChartPage() {
  const { t } = useI18n();
  const { data: tree, loading } = useAsync(() => getOrgChart(), []);

  return (
    <div className="max-w-3xl space-y-6">
      <h1 className="text-xl font-semibold text-ink-900">{t('orgChart.title')}</h1>
      <Card>
        <CardBody>
          {loading ? (
            <PageSpinner />
          ) : !tree || tree.length === 0 ? (
            <EmptyState title={t('common.noData')} />
          ) : (
            <ul className="space-y-3">
              {tree.map((node) => (
                <OrgNode key={node.id} node={node} />
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
