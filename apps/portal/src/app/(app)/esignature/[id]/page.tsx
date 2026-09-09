'use client';

import { useParams } from 'next/navigation';
import { useState } from 'react';
import { useI18n } from '../../../../i18n/I18nProvider';
import { useAsync } from '../../../../lib/useAsync';
import {
  cancelSignatureRequest,
  downloadSignatureCertificate,
  downloadSignatureRequestDocument,
  getSignatureRequest,
  getSignatureRequestEvents,
  verifySignatureRequestIntegrity,
} from '../../../../lib/api/esignature';
import { formatDateTime } from '../../../../lib/format';
import { Card, CardBody, CardHeader, CardTitle } from '../../../../components/ui/Card';
import { Button } from '../../../../components/ui/Button';
import { Alert } from '../../../../components/ui/Alert';
import { PageSpinner } from '../../../../components/ui/Spinner';
import { StatusBadge } from '../../../../components/ui/Badge';
import type { DocumentIntegrityCheck } from '../../../../lib/api/types';

/** Admin/HR tracking detail — see docs/conventions/e-signatures.md. Every signer's status, the full evidentiary trail, and the document/certificate downloads + a live tamper-evidence check. */
export default function EsignatureDetailPage() {
  const { t, locale } = useI18n();
  const params = useParams<{ id: string }>();
  const id = params.id;

  const { data: request, loading, reload } = useAsync(() => getSignatureRequest(id), [id]);
  const { data: events } = useAsync(() => getSignatureRequestEvents(id), [id]);
  const [verification, setVerification] = useState<DocumentIntegrityCheck | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleVerify() {
    setBusy(true);
    try {
      setVerification(await verifySignatureRequestIntegrity(id));
    } finally {
      setBusy(false);
    }
  }

  async function handleCancel() {
    setBusy(true);
    try {
      await cancelSignatureRequest(id);
      reload();
    } finally {
      setBusy(false);
    }
  }

  if (loading || !request) {
    return <PageSpinner />;
  }

  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-ink-900">{request.title}</h1>
        <StatusBadge status={request.status} label={request.status} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('esignature.detail.signers')}</CardTitle>
        </CardHeader>
        <CardBody>
          <ul className="divide-y divide-ink-100">
            {(request.signers ?? []).map((signer) => (
              <li key={signer.id} data-testid="signer-row" className="flex items-center justify-between gap-3 py-2 text-sm">
                <span className="text-ink-700">
                  {signer.signerType === 'INTERNAL' ? signer.userId : `${signer.externalName} <${signer.externalEmail}>`}
                  <span className="ms-2 text-xs text-ink-400">({t(`esignature.admin.signer${signer.signerType === 'INTERNAL' ? 'Internal' : 'External'}`)}, #{signer.order})</span>
                </span>
                <StatusBadge status={signer.status} label={signer.status} />
              </li>
            ))}
          </ul>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('esignature.detail.documentSection')}</CardTitle>
        </CardHeader>
        <CardBody className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="secondary" onClick={() => downloadSignatureRequestDocument(id)}>
            {t('esignature.detail.document')}
          </Button>
          {request.certificate && (
            <Button size="sm" variant="secondary" onClick={() => downloadSignatureCertificate(id)}>
              {t('esignature.detail.certificate')}
            </Button>
          )}
          <Button size="sm" variant="secondary" loading={busy} onClick={handleVerify} data-testid="verify-integrity-button">
            {t('esignature.detail.verify')}
          </Button>
          {request.status !== 'COMPLETED' && request.status !== 'CANCELED' && request.status !== 'DECLINED' && (
            <Button size="sm" variant="danger" loading={busy} onClick={handleCancel}>
              {t('esignature.admin.cancel')}
            </Button>
          )}
        </CardBody>
      </Card>

      {verification && (
        <div data-testid="verify-result">
          <Alert tone={verification.valid ? 'success' : 'error'}>
            {verification.valid ? t('esignature.detail.verifyValid') : t('esignature.detail.verifyInvalid')}
          </Alert>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>{t('esignature.detail.events')}</CardTitle>
        </CardHeader>
        <CardBody>
          <ul className="space-y-2">
            {(events ?? []).map((event) => (
              <li key={event.id} data-testid="signature-event-row" className="text-xs text-ink-600">
                <span className="font-semibold text-ink-800">{event.eventType}</span> — {formatDateTime(event.occurredAt, locale)}
                {event.ipAddress ? ` · ${event.ipAddress}` : ''}
                {event.signingMethod ? ` · ${event.signingMethod}` : ''}
              </li>
            ))}
          </ul>
          <p className="mt-4 text-xs text-ink-400">{t('esignature.detail.complianceNote')}</p>
        </CardBody>
      </Card>
    </div>
  );
}
