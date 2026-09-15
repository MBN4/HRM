'use client';

import { useState } from 'react';
import { useAsync } from '../../../lib/useAsync';
import { usePlatformAuth } from '../../../lib/auth/PlatformAuthContext';
import {
  createSubProcessor,
  deleteSubProcessor,
  listCrossTenantRequests,
  listRegister,
  listRetentionPolicies,
  listSubProcessors,
  residencyOverview,
  runRetentionSweepNow,
} from '../../../lib/api/privacy';
import { Card } from '../../../components/ui/Card';
import { PageSpinner } from '../../../components/ui/Spinner';
import { Alert } from '../../../components/ui/Alert';
import { EmptyState } from '../../../components/ui/EmptyState';
import { Button } from '../../../components/ui/Button';
import { StatusBadge } from '../../../components/ui/Badge';
import { Input, Label } from '../../../components/ui/Field';

/**
 * The vendor console's cross-tenant privacy oversight surface (step 6.1) —
 * see docs/conventions/privacy-residency.md. Reads (register/retention
 * policy/sub-processors/residency overview/cross-tenant requests) are
 * PRIVACY_READ, held by both platform roles; authoring the catalog and
 * triggering the retention sweep are PLATFORM_OWNER-only — the same
 * `canManage` client-side hint (never the real enforcement — the backend's
 * own RBAC is) the country-packs page already establishes.
 */
export default function PrivacyOversightPage() {
  const { me } = usePlatformAuth();
  const canManage = me?.role === 'PLATFORM_OWNER';

  const { data: register, loading: registerLoading } = useAsync(() => listRegister(), []);
  const { data: retentionPolicies, loading: retentionLoading } = useAsync(() => listRetentionPolicies(), []);
  const { data: subProcessors, loading: subProcessorsLoading, reload: reloadSubProcessors } = useAsync(() => listSubProcessors(), []);
  const { data: residency, loading: residencyLoading } = useAsync(() => residencyOverview(), []);
  const { data: requests, loading: requestsLoading, reload: reloadRequests } = useAsync(() => listCrossTenantRequests(), []);

  const [newName, setNewName] = useState('');
  const [newPurpose, setNewPurpose] = useState('');
  const [newRegion, setNewRegion] = useState('');
  const [sweepResult, setSweepResult] = useState<Record<string, number> | null>(null);
  const [sweepRunning, setSweepRunning] = useState(false);

  async function handleCreateSubProcessor() {
    if (!newName || !newPurpose || !newRegion) return;
    await createSubProcessor({ name: newName, purpose: newPurpose, dataCategories: [], region: newRegion });
    setNewName('');
    setNewPurpose('');
    setNewRegion('');
    reloadSubProcessors();
  }

  async function handleRunSweep() {
    setSweepRunning(true);
    try {
      const result = await runRetentionSweepNow();
      setSweepResult(result);
      reloadRequests();
    } finally {
      setSweepRunning(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-ink-900">Data privacy</h1>
        <p className="text-sm text-ink-500">The processing register, retention policy, sub-processor disclosure, residency assignment, and cross-tenant privacy requests.</p>
      </div>

      <Card className="p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ink-800">Residency overview</h2>
        </div>
        {residencyLoading ? (
          <PageSpinner />
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-ink-100 text-left text-xs font-medium uppercase tracking-wide text-ink-500">
              <tr>
                <th className="px-2 py-2">Tenant</th>
                <th className="px-2 py-2">Hosting region</th>
                <th className="px-2 py-2">This deployment</th>
              </tr>
            </thead>
            <tbody>
              {(residency ?? []).map((row) => (
                <tr key={row.tenantId} className="border-b border-ink-50 last:border-0">
                  <td className="px-2 py-2">{row.tenantName}</td>
                  <td className="px-2 py-2 font-mono text-xs">{row.hostingRegion}</td>
                  <td className="px-2 py-2">
                    {row.thisDeploymentRegion === null ? (
                      <span className="text-xs text-ink-400">unset (single-region deployment)</span>
                    ) : (
                      <StatusBadge status={row.matchesThisDeployment ? 'OK' : 'MISMATCH'} />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card className="p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ink-800">Retention policy (platform default)</h2>
          {canManage && (
            <Button size="sm" onClick={handleRunSweep} disabled={sweepRunning}>
              Run retention sweep now
            </Button>
          )}
        </div>
        {sweepResult && (
          <div className="mb-3">
            <Alert tone="info">
              Erased-by-tenant: {Object.entries(sweepResult).map(([tenantId, count]) => `${tenantId.slice(0, 8)}…: ${count}`).join(', ') || 'nothing eligible'}
            </Alert>
          </div>
        )}
        {retentionLoading ? (
          <PageSpinner />
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-ink-100 text-left text-xs font-medium uppercase tracking-wide text-ink-500">
              <tr>
                <th className="px-2 py-2">Category</th>
                <th className="px-2 py-2">Action</th>
                <th className="px-2 py-2">Months</th>
              </tr>
            </thead>
            <tbody>
              {(retentionPolicies ?? []).map((p) => (
                <tr key={p.category} className="border-b border-ink-50 last:border-0">
                  <td className="px-2 py-2 font-medium">{p.category}</td>
                  <td className="px-2 py-2">{p.action}</td>
                  <td className="px-2 py-2">{p.retentionMonths}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card className="p-4">
        <h2 className="mb-3 text-sm font-semibold text-ink-800">Processing register</h2>
        {registerLoading ? (
          <PageSpinner />
        ) : (
          <ul className="space-y-2">
            {(register ?? []).map((entry) => (
              <li key={entry.category} className="text-sm">
                <span className="font-medium">{entry.category}</span> — <span className="text-ink-600">{entry.description}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="p-4">
        <h2 className="mb-3 text-sm font-semibold text-ink-800">Sub-processors</h2>
        {subProcessorsLoading ? (
          <PageSpinner />
        ) : !subProcessors || subProcessors.length === 0 ? (
          <EmptyState title="No sub-processors recorded" />
        ) : (
          <ul className="mb-4 space-y-2">
            {subProcessors.map((sp) => (
              <li key={sp.id} className="flex items-center justify-between text-sm">
                <span>
                  <span className="font-medium">{sp.name}</span> — {sp.purpose} <span className="text-xs text-ink-400">({sp.region})</span>
                </span>
                {canManage && (
                  <Button size="sm" variant="ghost" onClick={() => deleteSubProcessor(sp.id).then(() => reloadSubProcessors())}>
                    Remove
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        {canManage && (
          <div className="grid grid-cols-3 gap-2">
            <div>
              <Label htmlFor="sp-name">Name</Label>
              <Input id="sp-name" value={newName} onChange={(e) => setNewName(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="sp-purpose">Purpose</Label>
              <Input id="sp-purpose" value={newPurpose} onChange={(e) => setNewPurpose(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="sp-region">Region</Label>
              <Input id="sp-region" value={newRegion} onChange={(e) => setNewRegion(e.target.value)} />
            </div>
            <Button size="sm" className="col-span-3" onClick={handleCreateSubProcessor}>
              Add sub-processor
            </Button>
          </div>
        )}
      </Card>

      <Card className="p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ink-800">Cross-tenant privacy requests</h2>
          <Button size="sm" variant="secondary" onClick={() => reloadRequests()}>
            Refresh
          </Button>
        </div>
        {requestsLoading ? (
          <PageSpinner />
        ) : !requests || requests.length === 0 ? (
          <EmptyState title="No data-subject requests yet" />
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-ink-100 text-left text-xs font-medium uppercase tracking-wide text-ink-500">
              <tr>
                <th className="px-2 py-2">Tenant</th>
                <th className="px-2 py-2">Type</th>
                <th className="px-2 py-2">Subject</th>
                <th className="px-2 py-2">Status</th>
                <th className="px-2 py-2">Created</th>
              </tr>
            </thead>
            <tbody>
              {requests.map((r) => (
                <tr key={r.id} className="border-b border-ink-50 last:border-0">
                  <td className="px-2 py-2 font-mono text-xs">{r.tenantId.slice(0, 8)}…</td>
                  <td className="px-2 py-2">
                    {r.requestType} {r.systemInitiated && <span className="text-xs text-ink-400">(system)</span>}
                  </td>
                  <td className="px-2 py-2">
                    {r.subjectType} {r.subjectId.slice(0, 8)}…
                  </td>
                  <td className="px-2 py-2">
                    <StatusBadge status={r.status} />
                  </td>
                  <td className="px-2 py-2 text-ink-500">{new Date(r.createdAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
