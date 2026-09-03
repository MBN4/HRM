'use client';

import { FormEvent, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { AlertTriangle, Copy, ShieldAlert } from 'lucide-react';
import { useAsync } from '../../../../lib/useAsync';
import { usePlatformAuth } from '../../../../lib/auth/PlatformAuthContext';
import { deleteTenant, getTenant, listTenantUsers, resumeTenant, suspendTenant, updateTenant } from '../../../../lib/api/tenants';
import { getTenantUsage } from '../../../../lib/api/usage';
import { startImpersonation } from '../../../../lib/api/impersonation';
import { apiFetch, ApiError } from '../../../../lib/api/client';
import { Card, CardBody, CardHeader, CardTitle } from '../../../../components/ui/Card';
import { PageSpinner, Spinner } from '../../../../components/ui/Spinner';
import { Alert } from '../../../../components/ui/Alert';
import { Button } from '../../../../components/ui/Button';
import { Input, Label, Select } from '../../../../components/ui/Field';
import { StatusBadge } from '../../../../components/ui/Badge';
import { Modal } from '../../../../components/ui/Modal';

export default function TenantDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { me } = usePlatformAuth();
  const canManage = me?.role === 'PLATFORM_OWNER';
  const { data: tenant, loading, error, reload } = useAsync(() => getTenant(params.id), [params.id]);
  const { data: usage, reload: reloadUsage } = useAsync(() => getTenantUsage(params.id), [params.id]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showImpersonate, setShowImpersonate] = useState(false);
  const [showLicense, setShowLicense] = useState(false);
  const [showDelete, setShowDelete] = useState(false);

  // Only the INITIAL load blocks the whole page — a subsequent `reload()`
  // (after suspend/resume/edit/...) must not unmount this page's own
  // in-flight confirmation UI (e.g. EditTenantForm's "Saved." message)
  // out from under the admin while the fresh data streams back in.
  if (loading && !tenant) return <PageSpinner />;
  if (error || !tenant) return <Alert tone="error">{error ?? 'Not found.'}</Alert>;

  async function runAction(fn: () => Promise<unknown>) {
    setActionError(null);
    try {
      await fn();
      reload();
      reloadUsage();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Something went wrong.');
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-semibold text-ink-900">{tenant.name}</h1>
          <p className="font-mono text-sm text-ink-500">{tenant.slug}</p>
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge status={tenant.status} />
          <StatusBadge status={tenant.edition} />
        </div>
      </div>

      {actionError && <Alert tone="error">{actionError}</Alert>}

      {tenant.status === 'SUSPENDED' && (
        <Alert tone="error">This tenant is SUSPENDED — every request for it (including login) is being blocked.</Alert>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Details</CardTitle>
          </CardHeader>
          <CardBody className="space-y-2 text-sm">
            <Row label="Hosting region" value={tenant.hostingRegion} />
            <Row label="Provision mode" value={tenant.provisionMode.replace('_', ' ')} />
            <Row label="Default country" value={tenant.defaultCountryCode} />
            <Row label="Base currency" value={tenant.baseCurrencyCode} />
            <Row label="Created" value={new Date(tenant.createdAt).toLocaleString()} />
            <Row label="Subscription" value={tenant.subscription ? `${tenant.subscription.edition} · ${tenant.subscription.status}` : '—'} />
            <Row
              label="Active license"
              value={tenant.activeLicense ? `${tenant.activeLicense.edition} · cap ${tenant.activeLicense.seatCap}` : '—'}
            />
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Usage</CardTitle>
          </CardHeader>
          <CardBody className="space-y-2 text-sm">
            {!usage ? (
              <Spinner className="h-4 w-4" />
            ) : (
              <>
                <Row
                  label="Active employees / cap"
                  value={`${usage.seats.activeEmployees} / ${usage.seats.licensedSeatCap ?? '∞'}`}
                  danger={usage.seats.overCap}
                />
                <Row label="Documents stored" value={String(usage.storage.documentCount)} />
                <Row label="Storage (bytes)" value={usage.storage.totalBytes.toLocaleString()} />
                <Row
                  label="API volume (current window)"
                  value={`${usage.apiVolume.currentWindowCount} / ${usage.apiVolume.currentWindowLimit}`}
                />
              </>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Lifecycle</CardTitle>
          </CardHeader>
          <CardBody className="space-y-2">
            {!canManage && <p className="text-xs text-ink-400">Read-only for PLATFORM_SUPPORT.</p>}
            {canManage && (
              <div className="flex flex-wrap gap-2">
                {tenant.status !== 'SUSPENDED' ? (
                  <Button variant="danger" size="sm" onClick={() => runAction(() => suspendTenant(tenant.id))}>
                    Suspend
                  </Button>
                ) : (
                  <Button size="sm" onClick={() => runAction(() => resumeTenant(tenant.id))}>
                    Resume
                  </Button>
                )}
                <Button variant="secondary" size="sm" onClick={() => setShowLicense(true)}>
                  License
                </Button>
                <Button variant="danger" size="sm" onClick={() => setShowDelete(true)}>
                  Delete
                </Button>
              </div>
            )}
            <div className="pt-2">
              <Button variant="secondary" size="sm" onClick={() => setShowImpersonate(true)}>
                <ShieldAlert className="h-4 w-4" aria-hidden /> Impersonate a user
              </Button>
            </div>
          </CardBody>
        </Card>
      </div>

      {canManage && <EditTenantForm tenantId={tenant.id} current={tenant} onSaved={reload} />}

      {showImpersonate && <ImpersonateModal tenantId={tenant.id} onClose={() => setShowImpersonate(false)} />}
      {showLicense && <LicenseModal tenantId={tenant.id} onClose={() => setShowLicense(false)} onDone={reload} />}
      {showDelete && (
        <DeleteTenantModal
          tenantId={tenant.id}
          slug={tenant.slug}
          onClose={() => setShowDelete(false)}
          onDeleted={() => router.replace('/tenants')}
        />
      )}
    </div>
  );
}

function Row({ label, value, danger }: { label: string; value: string; danger?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-ink-500">{label}</span>
      <span className={`font-medium ${danger ? 'text-coral-600' : 'text-ink-900'}`}>{value}</span>
    </div>
  );
}

function EditTenantForm({
  tenantId,
  current,
  onSaved,
}: {
  tenantId: string;
  current: { edition: string; hostingRegion: string; provisionMode: string };
  onSaved: () => void;
}) {
  const [edition, setEdition] = useState(current.edition);
  const [hostingRegion, setHostingRegion] = useState(current.hostingRegion);
  const [provisionMode, setProvisionMode] = useState(current.provisionMode);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    setSubmitting(true);
    try {
      await updateTenant(tenantId, { edition: edition as never, hostingRegion, provisionMode: provisionMode as never });
      setSaved(true);
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Edit edition / region / provision mode</CardTitle>
      </CardHeader>
      <CardBody>
        <form onSubmit={handleSubmit} className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div>
            <Label htmlFor="edition">Edition</Label>
            <Select id="edition" value={edition} onChange={(e) => setEdition(e.target.value)}>
              <option value="STARTER">STARTER</option>
              <option value="PROFESSIONAL">PROFESSIONAL</option>
              <option value="ENTERPRISE">ENTERPRISE</option>
            </Select>
          </div>
          <div>
            <Label htmlFor="region">Hosting region</Label>
            <Input id="region" value={hostingRegion} onChange={(e) => setHostingRegion(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="provisionMode">Provision mode</Label>
            <Select id="provisionMode" value={provisionMode} onChange={(e) => setProvisionMode(e.target.value)}>
              <option value="SHARED_DB">Shared DB</option>
              <option value="DB_PER_TENANT">DB per tenant</option>
            </Select>
          </div>
          <div className="sm:col-span-3">
            {error && <Alert tone="error">{error}</Alert>}
            {saved && <Alert tone="success">Saved.</Alert>}
            <Button type="submit" className="mt-2" loading={submitting}>
              Save changes
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}

function ImpersonateModal({ tenantId, onClose }: { tenantId: string; onClose: () => void }) {
  const { data: users, loading } = useAsync(() => listTenantUsers(tenantId), [tenantId]);
  const [targetUserId, setTargetUserId] = useState('');
  const [reason, setReason] = useState('');
  const [durationMinutes, setDurationMinutes] = useState(15);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ accessToken: string; expiresAt: string } | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await startImpersonation(tenantId, targetUserId, reason, durationMinutes);
      setResult({ accessToken: res.accessToken, expiresAt: res.session.expiresAt });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title="Impersonate a tenant user" onClose={onClose}>
      {result ? (
        <div className="space-y-3">
          <Alert tone="error">
            <AlertTriangle className="mr-1 inline h-4 w-4" aria-hidden /> You are now impersonating this user. Every action taken with
            this token is audited under your platform admin identity. Expires {new Date(result.expiresAt).toLocaleTimeString()}.
          </Alert>
          <div>
            <Label htmlFor="token">Access token</Label>
            <div className="flex gap-2">
              <Input id="token" readOnly value={result.accessToken} className="font-mono text-xs" />
              <Button type="button" variant="secondary" size="sm" onClick={() => navigator.clipboard.writeText(result.accessToken)}>
                <Copy className="h-4 w-4" aria-hidden />
              </Button>
            </div>
            <p className="mt-1 text-xs text-ink-400">
              Paste this into the tenant portal&apos;s session storage (or an API client) to act as this user. End the session from the
              Impersonation page when finished.
            </p>
          </div>
          <Button type="button" onClick={onClose}>
            Done
          </Button>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <Label htmlFor="targetUserId">Target user</Label>
            {loading ? (
              <Spinner className="h-4 w-4" />
            ) : (
              <Select id="targetUserId" value={targetUserId} onChange={(e) => setTargetUserId(e.target.value)} required>
                <option value="">Select a user…</option>
                {users?.map((u) => (
                  <option key={u.id} value={u.id} disabled={u.status !== 'ACTIVE'}>
                    {u.email} {u.status !== 'ACTIVE' ? `(${u.status})` : ''}
                  </option>
                ))}
              </Select>
            )}
          </div>
          <div>
            <Label htmlFor="reason">Reason (required, audited)</Label>
            <Input id="reason" value={reason} onChange={(e) => setReason(e.target.value)} required minLength={3} />
          </div>
          <div>
            <Label htmlFor="durationMinutes">Duration (minutes, capped server-side at 60)</Label>
            <Input
              id="durationMinutes"
              type="number"
              min={1}
              max={120}
              value={durationMinutes}
              onChange={(e) => setDurationMinutes(Number(e.target.value))}
            />
          </div>
          {error && <Alert tone="error">{error}</Alert>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="danger" loading={submitting}>
              Start impersonation
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}

function LicenseModal({ tenantId, onClose, onDone }: { tenantId: string; onClose: () => void; onDone: () => void }) {
  const [mode, setMode] = useState<'issue' | 'revoke'>('issue');
  const [edition, setEdition] = useState('PROFESSIONAL');
  const [seatCap, setSeatCap] = useState(50);
  const [expiresInDays, setExpiresInDays] = useState<number | ''>('');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [licenseFile, setLicenseFile] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      if (mode === 'issue') {
        const res = await apiFetch<{ licenseFile: string }>('/platform/licensing/issue', {
          method: 'POST',
          body: {
            tenantId,
            edition,
            enabledFlags: [],
            seatCap,
            ...(expiresInDays !== '' ? { expiresInDays } : {}),
          },
        });
        setLicenseFile(res.licenseFile);
      } else {
        await apiFetch('/platform/licensing/revoke', { method: 'POST', body: { tenantId, reason: reason || undefined } });
        onDone();
        onClose();
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title="Lifetime license" onClose={onClose}>
      <div className="mb-4 flex gap-2">
        <Button type="button" size="sm" variant={mode === 'issue' ? 'primary' : 'secondary'} onClick={() => setMode('issue')}>
          Issue
        </Button>
        <Button type="button" size="sm" variant={mode === 'revoke' ? 'primary' : 'secondary'} onClick={() => setMode('revoke')}>
          Revoke
        </Button>
      </div>

      {licenseFile ? (
        <div className="space-y-3">
          <Alert tone="success">License issued. Deliver this file to the customer (shown once).</Alert>
          <textarea readOnly value={licenseFile} className="h-32 w-full rounded-lg border border-ink-200 p-2 font-mono text-xs" />
          <Button type="button" onClick={() => { onDone(); onClose(); }}>
            Done
          </Button>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
          {mode === 'issue' ? (
            <>
              <div>
                <Label htmlFor="licEdition">Edition</Label>
                <Select id="licEdition" value={edition} onChange={(e) => setEdition(e.target.value)}>
                  <option value="STARTER">STARTER</option>
                  <option value="PROFESSIONAL">PROFESSIONAL</option>
                  <option value="ENTERPRISE">ENTERPRISE</option>
                </Select>
              </div>
              <div>
                <Label htmlFor="seatCap">Seat cap</Label>
                <Input id="seatCap" type="number" min={1} value={seatCap} onChange={(e) => setSeatCap(Number(e.target.value))} />
              </div>
              <div>
                <Label htmlFor="expiresInDays">Expires in days (blank = perpetual)</Label>
                <Input
                  id="expiresInDays"
                  type="number"
                  min={1}
                  value={expiresInDays}
                  onChange={(e) => setExpiresInDays(e.target.value === '' ? '' : Number(e.target.value))}
                />
              </div>
            </>
          ) : (
            <div>
              <Label htmlFor="reason">Reason (optional)</Label>
              <Input id="reason" value={reason} onChange={(e) => setReason(e.target.value)} />
            </div>
          )}
          {error && <Alert tone="error">{error}</Alert>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant={mode === 'revoke' ? 'danger' : 'primary'} loading={submitting}>
              {mode === 'issue' ? 'Issue license' : 'Revoke license'}
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}

function DeleteTenantModal({
  tenantId,
  slug,
  onClose,
  onDeleted,
}: {
  tenantId: string;
  slug: string;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [confirmSlug, setConfirmSlug] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await deleteTenant(tenantId, confirmSlug);
      onDeleted();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title="Delete tenant — irreversible" onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <Alert tone="error">
          This permanently deletes the tenant and ALL of its data (employees, payroll, everything). This cannot be undone.
        </Alert>
        <div>
          <Label htmlFor="confirmSlug">
            Type <span className="font-mono">{slug}</span> to confirm
          </Label>
          <Input id="confirmSlug" value={confirmSlug} onChange={(e) => setConfirmSlug(e.target.value)} required />
        </div>
        {error && <Alert tone="error">{error}</Alert>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="danger" loading={submitting} disabled={confirmSlug !== slug}>
            Permanently delete
          </Button>
        </div>
      </form>
    </Modal>
  );
}
