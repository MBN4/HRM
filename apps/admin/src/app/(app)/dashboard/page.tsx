'use client';

import { Building2, Users, ShieldCheck, Activity } from 'lucide-react';
import { useAsync } from '../../../lib/useAsync';
import { getUsageOverview } from '../../../lib/api/usage';
import { Card, CardBody } from '../../../components/ui/Card';
import { PageSpinner } from '../../../components/ui/Spinner';
import { Alert } from '../../../components/ui/Alert';

function StatTile({ icon: Icon, label, value }: { icon: typeof Building2; label: string; value: string | number }) {
  return (
    <Card>
      <CardBody className="flex items-center gap-4">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand-50 text-brand-600">
          <Icon className="h-5 w-5" aria-hidden />
        </div>
        <div>
          <p className="text-xs font-medium text-ink-500">{label}</p>
          <p className="text-2xl font-semibold text-ink-900">{value}</p>
        </div>
      </CardBody>
    </Card>
  );
}

export default function DashboardPage() {
  const { data, loading, error, reload } = useAsync(() => getUsageOverview(), []);

  if (loading) return <PageSpinner />;
  if (error || !data) {
    return (
      <Alert tone="error">
        {error ?? 'Failed to load.'}{' '}
        <button type="button" onClick={reload} className="underline">
          Retry
        </button>
      </Alert>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 data-testid="dashboard-heading" className="text-xl font-semibold text-ink-900">
          Platform overview
        </h1>
        <p className="text-sm text-ink-500">Cross-tenant health at a glance — precomputed, cheap reads only.</p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile icon={Building2} label="Total tenants" value={data.totalTenants} />
        <StatTile icon={Users} label="Active employees (all tenants)" value={data.totalActiveEmployees} />
        <StatTile icon={ShieldCheck} label="Active platform admins" value={data.totalPlatformAdmins} />
        <StatTile icon={Activity} label="Suspended tenants" value={data.byStatus.SUSPENDED ?? 0} />
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Card>
          <CardBody>
            <h2 className="mb-3 text-sm font-semibold text-ink-900">Tenants by status</h2>
            <dl className="space-y-2">
              {Object.entries(data.byStatus).map(([status, count]) => (
                <div key={status} className="flex items-center justify-between text-sm">
                  <dt className="text-ink-600">{status}</dt>
                  <dd className="font-medium text-ink-900">{count}</dd>
                </div>
              ))}
            </dl>
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <h2 className="mb-3 text-sm font-semibold text-ink-900">Tenants by edition</h2>
            <dl className="space-y-2">
              {Object.entries(data.byEdition).map(([edition, count]) => (
                <div key={edition} className="flex items-center justify-between text-sm">
                  <dt className="text-ink-600">{edition}</dt>
                  <dd className="font-medium text-ink-900">{count}</dd>
                </div>
              ))}
            </dl>
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
