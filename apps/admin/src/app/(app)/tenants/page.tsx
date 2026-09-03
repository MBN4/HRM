'use client';

import { FormEvent, useState } from 'react';
import Link from 'next/link';
import { Plus } from 'lucide-react';
import { useAsync } from '../../../lib/useAsync';
import { usePlatformAuth } from '../../../lib/auth/PlatformAuthContext';
import { createTenant, listTenants } from '../../../lib/api/tenants';
import { ApiError } from '../../../lib/api/client';
import { Card } from '../../../components/ui/Card';
import { PageSpinner } from '../../../components/ui/Spinner';
import { Alert } from '../../../components/ui/Alert';
import { EmptyState } from '../../../components/ui/EmptyState';
import { Button } from '../../../components/ui/Button';
import { Modal } from '../../../components/ui/Modal';
import { Input, Label, Select } from '../../../components/ui/Field';
import { StatusBadge } from '../../../components/ui/Badge';

export default function TenantsPage() {
  const { me } = usePlatformAuth();
  const { data, loading, error, reload } = useAsync(() => listTenants(), []);
  const [showCreate, setShowCreate] = useState(false);
  const canManage = me?.role === 'PLATFORM_OWNER';

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-ink-900">Tenants</h1>
          <p className="text-sm text-ink-500">Every tenant on this deployment — create, suspend, resume, delete.</p>
        </div>
        {canManage && (
          <Button onClick={() => setShowCreate(true)}>
            <Plus className="h-4 w-4" aria-hidden /> New tenant
          </Button>
        )}
      </div>

      {loading && <PageSpinner />}
      {error && <Alert tone="error">{error}</Alert>}
      {data && data.length === 0 && <EmptyState title="No tenants yet" description="Create the first one to get started." />}

      {data && data.length > 0 && (
        <Card className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-ink-100 bg-sand-50 text-left text-xs font-medium uppercase tracking-wide text-ink-500">
              <tr>
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Slug</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Edition</th>
                <th className="px-4 py-3">Region</th>
                <th className="px-4 py-3">Created</th>
              </tr>
            </thead>
            <tbody>
              {data.map((tenant) => (
                <tr key={tenant.id} className="border-b border-ink-50 last:border-0 hover:bg-sand-50">
                  <td className="px-4 py-3">
                    <Link href={`/tenants/${tenant.id}`} className="font-medium text-brand-700 hover:underline">
                      {tenant.name}
                    </Link>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-ink-600">{tenant.slug}</td>
                  <td className="px-4 py-3">
                    <StatusBadge status={tenant.status} />
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={tenant.edition} />
                  </td>
                  <td className="px-4 py-3 text-ink-600">{tenant.hostingRegion}</td>
                  <td className="px-4 py-3 text-ink-500">{new Date(tenant.createdAt).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {showCreate && <CreateTenantModal onClose={() => setShowCreate(false)} onCreated={reload} />}
    </div>
  );
}

function CreateTenantModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [defaultCountryCode, setDefaultCountryCode] = useState('US');
  const [hostingRegion, setHostingRegion] = useState('us-east-1');
  const [edition, setEdition] = useState('STARTER');
  const [provisionMode, setProvisionMode] = useState('SHARED_DB');
  const [withAdmin, setWithAdmin] = useState(false);
  const [adminEmail, setAdminEmail] = useState('');
  const [adminName, setAdminName] = useState('');
  const [adminPassword, setAdminPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await createTenant({
        name,
        slug,
        defaultCountryCode,
        hostingRegion,
        edition: edition as never,
        provisionMode: provisionMode as never,
        ...(withAdmin ? { initialAdminEmail: adminEmail, initialAdminName: adminName, initialAdminPassword: adminPassword } : {}),
      });
      onCreated();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title="Create tenant" onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <Label htmlFor="name">Name</Label>
          <Input id="name" value={name} onChange={(e) => setName(e.target.value)} required />
        </div>
        <div>
          <Label htmlFor="slug">Slug</Label>
          <Input id="slug" value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="acme" required />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="country">Default country code</Label>
            <Input id="country" value={defaultCountryCode} onChange={(e) => setDefaultCountryCode(e.target.value.toUpperCase())} maxLength={2} required />
          </div>
          <div>
            <Label htmlFor="region">Hosting region</Label>
            <Input id="region" value={hostingRegion} onChange={(e) => setHostingRegion(e.target.value)} required />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="edition">Edition</Label>
            <Select id="edition" value={edition} onChange={(e) => setEdition(e.target.value)}>
              <option value="STARTER">STARTER</option>
              <option value="PROFESSIONAL">PROFESSIONAL</option>
              <option value="ENTERPRISE">ENTERPRISE</option>
            </Select>
          </div>
          <div>
            <Label htmlFor="provisionMode">Provision mode</Label>
            <Select id="provisionMode" value={provisionMode} onChange={(e) => setProvisionMode(e.target.value)}>
              <option value="SHARED_DB">Shared DB</option>
              <option value="DB_PER_TENANT">DB per tenant (seam only)</option>
            </Select>
          </div>
        </div>

        <label className="flex items-center gap-2 text-sm text-ink-700">
          <input type="checkbox" checked={withAdmin} onChange={(e) => setWithAdmin(e.target.checked)} />
          Create an initial TENANT_ADMIN user
        </label>
        {withAdmin && (
          <div className="space-y-3 rounded-lg border border-ink-100 bg-sand-50 p-3">
            <div>
              <Label htmlFor="adminEmail">Admin email</Label>
              <Input id="adminEmail" type="email" value={adminEmail} onChange={(e) => setAdminEmail(e.target.value)} required={withAdmin} />
            </div>
            <div>
              <Label htmlFor="adminName">Admin name</Label>
              <Input id="adminName" value={adminName} onChange={(e) => setAdminName(e.target.value)} required={withAdmin} />
            </div>
            <div>
              <Label htmlFor="adminPassword">Temporary password</Label>
              <Input
                id="adminPassword"
                type="text"
                value={adminPassword}
                onChange={(e) => setAdminPassword(e.target.value)}
                minLength={12}
                required={withAdmin}
              />
            </div>
          </div>
        )}

        {error && <Alert tone="error">{error}</Alert>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={submitting}>
            Create tenant
          </Button>
        </div>
      </form>
    </Modal>
  );
}
