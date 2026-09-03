'use client';

import { FormEvent, useState } from 'react';
import { useAsync } from '../../../lib/useAsync';
import { listPlatformAuditLog, listTenantAuditLog } from '../../../lib/api/audit';
import type { PlatformAuditLogEntry, TenantAuditLogEntry } from '../../../lib/api/types';
import { Card } from '../../../components/ui/Card';
import { PageSpinner } from '../../../components/ui/Spinner';
import { Alert } from '../../../components/ui/Alert';
import { EmptyState } from '../../../components/ui/EmptyState';
import { Button } from '../../../components/ui/Button';
import { Input, Label } from '../../../components/ui/Field';

export default function AuditPage() {
  const [targetTenantId, setTargetTenantId] = useState('');
  const { data, loading, error, reload } = useAsync(() => listPlatformAuditLog({ targetTenantId: targetTenantId || undefined }), []);

  const [lookupTenantId, setLookupTenantId] = useState('');
  const [tenantEntries, setTenantEntries] = useState<TenantAuditLogEntry[] | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [lookupLoading, setLookupLoading] = useState(false);

  async function handleFilter(e: FormEvent) {
    e.preventDefault();
    reload();
  }

  async function handleTenantLookup(e: FormEvent) {
    e.preventDefault();
    setLookupError(null);
    setLookupLoading(true);
    try {
      const rows = await listTenantAuditLog(lookupTenantId);
      setTenantEntries(rows);
    } catch {
      setLookupError('Failed to read that tenant\'s audit log — check the tenant id.');
    } finally {
      setLookupLoading(false);
    }
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-xl font-semibold text-ink-900">Cross-tenant audit trail</h1>
        <p className="text-sm text-ink-500">The single most sensitive read in this system — every read here is itself audited.</p>
      </div>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-ink-900">Platform&apos;s own audit log (tenant lifecycle, licensing, packs, impersonation, ...)</h2>
        <form onSubmit={handleFilter} className="flex items-end gap-3">
          <div>
            <Label htmlFor="filterTenantId">Filter by target tenant id (optional)</Label>
            <Input id="filterTenantId" value={targetTenantId} onChange={(e) => setTargetTenantId(e.target.value)} className="w-96" />
          </div>
          <Button type="submit">Filter</Button>
        </form>

        {loading && <PageSpinner />}
        {error && <Alert tone="error">{error}</Alert>}
        {data && data.length === 0 && <EmptyState title="No entries match" />}
        {data && data.length > 0 && <PlatformAuditTable rows={data} />}
      </section>

      <section className="space-y-3 border-t border-ink-100 pt-6">
        <h2 className="text-sm font-semibold text-ink-900">A specific tenant&apos;s own audit_log (cross-tenant read)</h2>
        <form onSubmit={handleTenantLookup} className="flex items-end gap-3">
          <div>
            <Label htmlFor="lookupTenantId">Tenant id</Label>
            <Input id="lookupTenantId" value={lookupTenantId} onChange={(e) => setLookupTenantId(e.target.value)} required className="w-96" />
          </div>
          <Button type="submit" loading={lookupLoading}>
            Read
          </Button>
        </form>
        {lookupError && <Alert tone="error">{lookupError}</Alert>}
        {tenantEntries && tenantEntries.length === 0 && <EmptyState title="No entries for this tenant" />}
        {tenantEntries && tenantEntries.length > 0 && <TenantAuditTable rows={tenantEntries} />}
      </section>
    </div>
  );
}

function PlatformAuditTable({ rows }: { rows: PlatformAuditLogEntry[] }) {
  return (
    <Card className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="border-b border-ink-100 bg-sand-50 text-left text-xs font-medium uppercase tracking-wide text-ink-500">
          <tr>
            <th className="px-4 py-3">When</th>
            <th className="px-4 py-3">Action</th>
            <th className="px-4 py-3">Entity</th>
            <th className="px-4 py-3">Platform admin</th>
            <th className="px-4 py-3">Target tenant</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={`${row.id}-${row.occurredAt}`} className="border-b border-ink-50 last:border-0">
              <td className="px-4 py-3 text-ink-500">{new Date(row.occurredAt).toLocaleString()}</td>
              <td className="px-4 py-3 font-medium text-ink-900">{row.action}</td>
              <td className="px-4 py-3 text-ink-600">
                {row.entityType} {row.entityId ? `· ${row.entityId}` : ''}
              </td>
              <td className="px-4 py-3 font-mono text-xs text-ink-500">{row.platformAdminId ?? '(system)'}</td>
              <td className="px-4 py-3 font-mono text-xs text-ink-500">{row.targetTenantId ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function TenantAuditTable({ rows }: { rows: TenantAuditLogEntry[] }) {
  return (
    <Card className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="border-b border-ink-100 bg-sand-50 text-left text-xs font-medium uppercase tracking-wide text-ink-500">
          <tr>
            <th className="px-4 py-3">When</th>
            <th className="px-4 py-3">Action</th>
            <th className="px-4 py-3">Entity</th>
            <th className="px-4 py-3">Actor</th>
            <th className="px-4 py-3">Impersonated by</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const impersonatedBy =
              row.metadata && typeof row.metadata === 'object' && 'impersonatedByPlatformAdminId' in row.metadata
                ? ((row.metadata as Record<string, unknown>).impersonatedByPlatformAdminId as string | null)
                : null;
            return (
              <tr key={row.id} className="border-b border-ink-50 last:border-0">
                <td className="px-4 py-3 text-ink-500">{new Date(row.occurredAt).toLocaleString()}</td>
                <td className="px-4 py-3 font-medium text-ink-900">{row.action}</td>
                <td className="px-4 py-3 text-ink-600">
                  {row.entityType} {row.entityId ? `· ${row.entityId}` : ''}
                </td>
                <td className="px-4 py-3 font-mono text-xs text-ink-500">
                  {row.actorPlatform ? 'platform' : (row.actorUserId ?? '—')}
                </td>
                <td className="px-4 py-3 font-mono text-xs text-coral-600">{impersonatedBy ?? '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Card>
  );
}
