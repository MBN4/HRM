'use client';

import { useState } from 'react';
import Link from 'next/link';
import { FileSignature, Plus } from 'lucide-react';
import { PERMISSIONS } from '@hrm/shared';
import { useI18n } from '../../../i18n/I18nProvider';
import { useAuth } from '../../../lib/auth/AuthContext';
import { useAsync } from '../../../lib/useAsync';
import { listSignatureRequests, sendSignatureRequest } from '../../../lib/api/esignature';
import { formatDate } from '../../../lib/format';
import { Card, CardBody, CardHeader, CardTitle } from '../../../components/ui/Card';
import { Button } from '../../../components/ui/Button';
import { Modal } from '../../../components/ui/Modal';
import { Alert } from '../../../components/ui/Alert';
import { EmptyState } from '../../../components/ui/EmptyState';
import { PageSpinner } from '../../../components/ui/Spinner';
import { StatusBadge } from '../../../components/ui/Badge';
import { SignatureRequestForm } from '../../../components/esignature/SignatureRequestForm';

/** Admin/HR tracking + creation — see docs/conventions/e-signatures.md. `esignature.manage` gates the list itself; creation is additionally reachable to a `POLICY_READ` holder self-requesting their OWN policy acknowledgment (see the announcements page), which is why `esignature.request`'s absence doesn't hide this whole page — only `esignature.manage`'s does. */
export default function EsignatureAdminPage() {
  const { t, locale } = useI18n();
  const { can } = useAuth();
  const [creating, setCreating] = useState(false);
  const [sendingId, setSendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const canManage = can(PERMISSIONS.ESIGNATURE_MANAGE);
  const { data: requests, loading, reload } = useAsync(() => (canManage ? listSignatureRequests() : Promise.resolve([])), [canManage]);

  if (!canManage) {
    return <Alert tone="info">{t('error.forbidden')}</Alert>;
  }

  async function handleSend(id: string) {
    setSendingId(id);
    setError(null);
    try {
      await sendSignatureRequest(id);
      reload();
    } catch {
      setError(t('error.generic'));
    } finally {
      setSendingId(null);
    }
  }

  return (
    <div className="max-w-4xl space-y-6">
      <h1 className="text-xl font-semibold text-ink-900">{t('esignature.admin.title')}</h1>

      <Card>
        <CardHeader>
          <CardTitle>{t('esignature.admin.title')}</CardTitle>
          {can(PERMISSIONS.ESIGNATURE_REQUEST) && (
            <Button size="sm" data-testid="new-signature-request-button" onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" aria-hidden />
              {t('esignature.admin.newRequest')}
            </Button>
          )}
        </CardHeader>
        <CardBody>
          {error && (
            <div className="mb-3">
              <Alert tone="error">{error}</Alert>
            </div>
          )}
          {loading ? (
            <PageSpinner />
          ) : !requests || requests.length === 0 ? (
            <EmptyState icon={FileSignature} title={t('esignature.admin.noRequests')} />
          ) : (
            <ul className="divide-y divide-ink-100">
              {requests.map((r) => (
                <li key={r.id} data-testid="signature-request-row" className="flex items-center justify-between gap-3 py-3">
                  <div>
                    <Link href={`/esignature/${r.id}`} className="text-sm font-semibold text-brand-700 hover:underline">
                      {r.title}
                    </Link>
                    <p className="mt-1 text-xs text-ink-400">
                      {r.entityType ? `${t('esignature.admin.entity')}: ${r.entityType}` : null} {formatDate(r.createdAt, locale)}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <StatusBadge status={r.status} label={r.status} />
                    {r.status === 'DRAFT' && (
                      <Button size="sm" loading={sendingId === r.id} onClick={() => handleSend(r.id)}>
                        {t('esignature.admin.send')}
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      {creating && (
        <Modal title={t('esignature.admin.newRequest')} onClose={() => setCreating(false)}>
          <SignatureRequestForm
            onCancel={() => setCreating(false)}
            onSubmitted={() => {
              setCreating(false);
              reload();
            }}
          />
        </Modal>
      )}
    </div>
  );
}
