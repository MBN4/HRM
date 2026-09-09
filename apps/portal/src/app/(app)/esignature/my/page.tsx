'use client';

import { useState } from 'react';
import { FileSignature } from 'lucide-react';
import { useI18n } from '../../../../i18n/I18nProvider';
import { useAsync } from '../../../../lib/useAsync';
import { declineMine, myPendingSignatures, signMine, viewMySignatureDocument, SignInput } from '../../../../lib/api/esignature';
import { ApiError } from '../../../../lib/api/client';
import { Card, CardBody, CardHeader, CardTitle } from '../../../../components/ui/Card';
import { Button } from '../../../../components/ui/Button';
import { Modal } from '../../../../components/ui/Modal';
import { Alert } from '../../../../components/ui/Alert';
import { EmptyState } from '../../../../components/ui/EmptyState';
import { PageSpinner } from '../../../../components/ui/Spinner';
import { StatusBadge } from '../../../../components/ui/Badge';
import { SignaturePad } from '../../../../components/esignature/SignaturePad';

/**
 * ESS self-service signing — see docs/conventions/e-signatures.md. Lists
 * every `SignatureSigner` row the caller is themselves (internal signer,
 * `SENT`/`VIEWED`) — every offer/policy/generic-contract integration lands
 * here identically, the same "one generic inbox" posture the
 * `/approvals` page already establishes for the workflow engine.
 */
export default function MySignaturesPage() {
  const { t } = useI18n();
  const [signingId, setSigningId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: pending, loading, reload } = useAsync(() => myPendingSignatures(), []);

  async function handleView(signerId: string) {
    try {
      await viewMySignatureDocument(signerId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('error.generic'));
    }
  }

  async function handleSign(signerId: string, input: SignInput) {
    setSubmitting(true);
    setError(null);
    try {
      await signMine(signerId, input);
      setSigningId(null);
      reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('error.generic'));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDecline(signerId: string) {
    setError(null);
    try {
      await declineMine(signerId);
      reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('error.generic'));
    }
  }

  return (
    <div className="max-w-2xl space-y-6">
      <h1 className="text-xl font-semibold text-ink-900">{t('esignature.my.title')}</h1>

      {error && <Alert tone="error">{error}</Alert>}

      <Card>
        <CardHeader>
          <CardTitle>{t('esignature.my.title')}</CardTitle>
        </CardHeader>
        <CardBody>
          {loading ? (
            <PageSpinner />
          ) : !pending || pending.length === 0 ? (
            <EmptyState icon={FileSignature} title={t('esignature.my.noPending')} />
          ) : (
            <ul className="divide-y divide-ink-100">
              {pending.map((signer) => (
                <li key={signer.id} data-testid="my-signature-row" className="flex items-center justify-between gap-3 py-3">
                  <div>
                    <StatusBadge status={signer.status} label={signer.status} />
                  </div>
                  <div className="flex items-center gap-2">
                    <Button size="sm" variant="secondary" onClick={() => handleView(signer.id)} data-testid="view-document-button">
                      {t('esignature.my.viewDocument')}
                    </Button>
                    <Button size="sm" onClick={() => setSigningId(signer.id)} data-testid="sign-document-button">
                      {t('esignature.my.sign')}
                    </Button>
                    <Button size="sm" variant="danger" onClick={() => handleDecline(signer.id)}>
                      {t('esignature.my.decline')}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      {signingId && (
        <Modal title={t('esignature.my.sign')} onClose={() => setSigningId(null)}>
          <SignaturePad submitting={submitting} onSubmit={(input) => handleSign(signingId, input)} />
        </Modal>
      )}
    </div>
  );
}
