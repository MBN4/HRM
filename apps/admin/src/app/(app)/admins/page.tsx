'use client';

import { FormEvent, useState } from 'react';
import { Plus } from 'lucide-react';
import { useAsync } from '../../../lib/useAsync';
import { usePlatformAuth } from '../../../lib/auth/PlatformAuthContext';
import { createPlatformAdmin, listPlatformAdmins, updatePlatformAdmin } from '../../../lib/api/admins';
import { ApiError } from '../../../lib/api/client';
import { Card } from '../../../components/ui/Card';
import { PageSpinner } from '../../../components/ui/Spinner';
import { Alert } from '../../../components/ui/Alert';
import { Button } from '../../../components/ui/Button';
import { Modal } from '../../../components/ui/Modal';
import { Input, Label, Select } from '../../../components/ui/Field';
import { StatusBadge, Badge } from '../../../components/ui/Badge';

export default function AdminsPage() {
  const { me } = usePlatformAuth();
  const { data, loading, error, reload } = useAsync(() => listPlatformAdmins(), []);
  const [showCreate, setShowCreate] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  if (me?.role !== 'PLATFORM_OWNER') {
    return <Alert tone="error">Managing platform admin accounts is restricted to PLATFORM_OWNER.</Alert>;
  }

  async function handleSuspend(id: string, status: 'ACTIVE' | 'SUSPENDED') {
    setActionError(null);
    try {
      await updatePlatformAdmin(id, { status: status === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE' });
      reload();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Something went wrong.');
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-ink-900">Platform admins</h1>
          <p className="text-sm text-ink-500">Vendor operations staff — a separate identity space from tenant users.</p>
        </div>
        <Button onClick={() => setShowCreate(true)}>
          <Plus className="h-4 w-4" aria-hidden /> New platform admin
        </Button>
      </div>

      {actionError && <Alert tone="error">{actionError}</Alert>}
      {loading && <PageSpinner />}
      {error && <Alert tone="error">{error}</Alert>}

      {data && (
        <Card className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-ink-100 bg-sand-50 text-left text-xs font-medium uppercase tracking-wide text-ink-500">
              <tr>
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Email</th>
                <th className="px-4 py-3">Role</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">MFA</th>
                <th className="px-4 py-3">Last login</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {data.map((admin) => (
                <tr key={admin.id} className="border-b border-ink-50 last:border-0 hover:bg-sand-50">
                  <td className="px-4 py-3 font-medium text-ink-900">{admin.name}</td>
                  <td className="px-4 py-3 text-ink-600">{admin.email}</td>
                  <td className="px-4 py-3">
                    <StatusBadge status={admin.role} />
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={admin.status} />
                  </td>
                  <td className="px-4 py-3">
                    <Badge tone={admin.mfaEnabled ? 'success' : 'warning'}>{admin.mfaEnabled ? 'Enrolled' : 'Not enrolled'}</Badge>
                  </td>
                  <td className="px-4 py-3 text-ink-500">{admin.lastLoginAt ? new Date(admin.lastLoginAt).toLocaleString() : 'Never'}</td>
                  <td className="px-4 py-3">
                    <Button size="sm" variant={admin.status === 'ACTIVE' ? 'danger' : 'secondary'} onClick={() => handleSuspend(admin.id, admin.status)}>
                      {admin.status === 'ACTIVE' ? 'Suspend' : 'Reactivate'}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {showCreate && <CreateAdminModal onClose={() => setShowCreate(false)} onCreated={reload} />}
    </div>
  );
}

function CreateAdminModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState('PLATFORM_SUPPORT');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await createPlatformAdmin({ email, name, password, role: role as never });
      onCreated();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title="Create platform admin" onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <Label htmlFor="email">Email</Label>
          <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </div>
        <div>
          <Label htmlFor="name">Name</Label>
          <Input id="name" value={name} onChange={(e) => setName(e.target.value)} required />
        </div>
        <div>
          <Label htmlFor="password">Temporary password (12+ characters)</Label>
          <Input id="password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={12} required />
        </div>
        <div>
          <Label htmlFor="role">Role</Label>
          <Select id="role" value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="PLATFORM_SUPPORT">PLATFORM_SUPPORT (read + impersonate)</option>
            <option value="PLATFORM_OWNER">PLATFORM_OWNER (full access)</option>
          </Select>
        </div>
        <Alert tone="info">MFA is mandatory — this admin must complete enrollment on their first login before they can do anything.</Alert>
        {error && <Alert tone="error">{error}</Alert>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={submitting}>
            Create admin
          </Button>
        </div>
      </form>
    </Modal>
  );
}
