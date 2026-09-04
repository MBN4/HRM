'use client';

import Link from 'next/link';
import { useAsync } from '../../../lib/useAsync';
import { listBrandings } from '../../../lib/api/branding';
import { Card } from '../../../components/ui/Card';
import { PageSpinner } from '../../../components/ui/Spinner';
import { Alert } from '../../../components/ui/Alert';
import { EmptyState } from '../../../components/ui/EmptyState';
import { StatusBadge } from '../../../components/ui/Badge';

/**
 * The vendor console's branding oversight surface (step 4.3) — a cheap
 * indexed read (`PlatformBrandingService.listBrandings`), never a
 * per-tenant loop, the same "cheap reads only" posture the Usage/Billing
 * overview pages already take. Read-only for BOTH roles here — verifying/
 * approving a domain, provisioning TLS, or resetting a tenant's branding
 * happens on a tenant's own detail page, gated PLATFORM_OWNER-only there.
 */
export default function BrandingOverviewPage() {
  const { data, loading, error } = useAsync(() => listBrandings(), []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-ink-900">Branding</h1>
        <p className="text-sm text-ink-500">Every tenant&apos;s branding and custom-domain state — open a tenant to verify a domain or provision TLS.</p>
      </div>

      {loading && <PageSpinner />}
      {error && <Alert tone="error">{error}</Alert>}
      {data && data.length === 0 && <EmptyState title="No tenants yet" />}

      {data && data.length > 0 && (
        <Card className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-ink-100 bg-sand-50 text-left text-xs font-medium uppercase tracking-wide text-ink-500">
              <tr>
                <th className="px-4 py-3">Tenant</th>
                <th className="px-4 py-3">Product name</th>
                <th className="px-4 py-3">Logo</th>
                <th className="px-4 py-3">Full rebrand</th>
                <th className="px-4 py-3">Domain</th>
                <th className="px-4 py-3">Cert</th>
              </tr>
            </thead>
            <tbody>
              {data.map((row) => (
                <tr key={row.tenantId} className="border-b border-ink-50 last:border-0 hover:bg-sand-50">
                  <td className="px-4 py-3">
                    <Link href={`/tenants/${row.tenantId}`} className="font-medium text-brand-700 hover:underline">
                      {row.tenantName}
                    </Link>
                    <span className="ms-2 font-mono text-xs text-ink-400">{row.tenantSlug}</span>
                  </td>
                  <td className="px-4 py-3 text-ink-600">{row.productName ?? '—'}</td>
                  <td className="px-4 py-3 text-ink-600">{row.hasLogo ? 'Yes' : '—'}</td>
                  <td className="px-4 py-3">{row.fullRebrandEnabled ? <StatusBadge status="ACTIVE" /> : '—'}</td>
                  <td className="px-4 py-3 text-ink-600">
                    {row.domain ? (
                      <>
                        {row.domain.domain} <StatusBadge status={row.domain.verificationStatus} />
                      </>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="px-4 py-3">{row.domain ? <StatusBadge status={row.domain.certStatus} /> : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
