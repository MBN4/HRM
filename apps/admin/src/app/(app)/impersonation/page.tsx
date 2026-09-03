'use client';

import { useState } from 'react';
import { useAsync } from '../../../lib/useAsync';
import { endImpersonation, listImpersonationSessions, revokeImpersonation } from '../../../lib/api/impersonation';
import { usePlatformAuth } from '../../../lib/auth/PlatformAuthContext';
import { ApiError } from '../../../lib/api/client';
import { Card } from '../../../components/ui/Card';
import { PageSpinner } from '../../../components/ui/Spinner';
import { Alert } from '../../../components/ui/Alert';
import { EmptyState } from '../../../components/ui/EmptyState';
import { Badge } from '../../../components/ui/Badge';
import { Button } from '../../../components/ui/Button';

function sessionState(endedAt: string | null, expiresAt: string): { label: string; tone: 'success' | 'neutral' | 'danger' } {
  if (endedAt) return { label: 'Ended', tone: 'neutral' };
  if (new Date(expiresAt).getTime() < Date.now()) return { label: 'Expired', tone: 'neutral' };
  return { label: 'Active', tone: 'danger' };
}

export default function ImpersonationPage() {
  const { me } = usePlatformAuth();
  const [activeOnly, setActiveOnly] = useState(false);
  const { data, loading, error, reload } = useAsync(() => listImpersonationSessions({ activeOnly }), [activeOnly]);
  const [actionError, setActionError] = useState<string | null>(null);

  async function handleEnd(sessionId: string, ownedByMe: boolean) {
    setActionError(null);
    try {
      if (ownedByMe) {
        await endImpersonation(sessionId);
      } else {
        await revokeImpersonation(sessionId);
      }
      reload();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Something went wrong.');
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-ink-900">Impersonation sessions</h1>
          <p className="text-sm text-ink-500">Every support impersonation session, across every tenant — loudly audited.</p>
        </div>
        <label className="flex items-center gap-2 text-sm text-ink-700">
          <input type="checkbox" checked={activeOnly} onChange={(e) => setActiveOnly(e.target.checked)} />
          Active only
        </label>
      </div>

      {actionError && <Alert tone="error">{actionError}</Alert>}
      {loading && <PageSpinner />}
      {error && <Alert tone="error">{error}</Alert>}
      {data && data.length === 0 && <EmptyState title="No impersonation sessions" />}

      {data && data.length > 0 && (
        <Card className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-ink-100 bg-sand-50 text-left text-xs font-medium uppercase tracking-wide text-ink-500">
              <tr>
                <th className="px-4 py-3">Tenant</th>
                <th className="px-4 py-3">Target user</th>
                <th className="px-4 py-3">Platform admin</th>
                <th className="px-4 py-3">Reason</th>
                <th className="px-4 py-3">Started</th>
                <th className="px-4 py-3">Expires</th>
                <th className="px-4 py-3">State</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {data.map((s) => {
                const state = sessionState(s.endedAt, s.expiresAt);
                const ownedByMe = s.platformAdminId === me?.platformAdminId;
                return (
                  <tr key={s.id} className="border-b border-ink-50 last:border-0 hover:bg-sand-50">
                    <td className="px-4 py-3 font-mono text-xs text-ink-600">{s.tenantId}</td>
                    <td className="px-4 py-3 font-mono text-xs text-ink-600">{s.targetUserId}</td>
                    <td className="px-4 py-3 font-mono text-xs text-ink-600">{s.platformAdminId}</td>
                    <td className="px-4 py-3 text-ink-700">{s.reason}</td>
                    <td className="px-4 py-3 text-ink-500">{new Date(s.startedAt).toLocaleString()}</td>
                    <td className="px-4 py-3 text-ink-500">{new Date(s.expiresAt).toLocaleString()}</td>
                    <td className="px-4 py-3">
                      <Badge tone={state.tone}>{state.label}</Badge>
                    </td>
                    <td className="px-4 py-3">
                      {state.label === 'Active' && (
                        <Button size="sm" variant="danger" onClick={() => handleEnd(s.id, ownedByMe)}>
                          {ownedByMe ? 'End' : 'Revoke'}
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
