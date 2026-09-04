'use client';

import Link from 'next/link';
import { useAsync } from '../../../lib/useAsync';
import { listSubscriptions } from '../../../lib/api/billing';
import { Card } from '../../../components/ui/Card';
import { PageSpinner } from '../../../components/ui/Spinner';
import { Alert } from '../../../components/ui/Alert';
import { EmptyState } from '../../../components/ui/EmptyState';
import { StatusBadge } from '../../../components/ui/Badge';

/**
 * The vendor console's cross-tenant billing overview (step 4.2) — a cheap
 * indexed read (`PlatformBillingService.listSubscriptions`), never a
 * per-tenant loop, the same "cheap reads only" posture the Usage page
 * already takes. Read-only for BOTH roles here — mutating billing (AMC
 * invoicing, a resync) happens on a tenant's own detail page, gated
 * PLATFORM_OWNER-only there.
 */
export default function BillingOverviewPage() {
  const { data, loading, error } = useAsync(() => listSubscriptions(), []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-ink-900">Billing</h1>
        <p className="text-sm text-ink-500">Every tenant&apos;s subscription state — open a tenant to manage invoices or trigger AMC billing.</p>
      </div>

      {loading && <PageSpinner />}
      {error && <Alert tone="error">{error}</Alert>}
      {data && data.length === 0 && <EmptyState title="No subscriptions yet" />}

      {data && data.length > 0 && (
        <Card className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-ink-100 bg-sand-50 text-left text-xs font-medium uppercase tracking-wide text-ink-500">
              <tr>
                <th className="px-4 py-3">Tenant</th>
                <th className="px-4 py-3">Edition</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Seats</th>
                <th className="px-4 py-3">Renews</th>
              </tr>
            </thead>
            <tbody>
              {data.map((sub) => (
                <tr key={sub.tenantId} className="border-b border-ink-50 last:border-0 hover:bg-sand-50">
                  <td className="px-4 py-3">
                    <Link href={`/tenants/${sub.tenantId}`} className="font-medium text-brand-700 hover:underline">
                      {sub.tenantName}
                    </Link>
                    <span className="ms-2 font-mono text-xs text-ink-400">{sub.tenantSlug}</span>
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={sub.edition} />
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={sub.status} />
                    {sub.cancelAtPeriodEnd && <span className="ms-2 text-xs text-coral-600">cancels at period end</span>}
                  </td>
                  <td className="px-4 py-3 text-ink-600">{sub.quantity ?? '—'}</td>
                  <td className="px-4 py-3 text-ink-500">{sub.currentPeriodEnd ? new Date(sub.currentPeriodEnd).toLocaleDateString() : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
