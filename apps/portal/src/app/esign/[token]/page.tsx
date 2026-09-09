'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { useI18n } from '../../../i18n/I18nProvider';
import { setStoredTenantSlug } from '../../../lib/tenant';
import { ApiError } from '../../../lib/api/client';
import { declineViaLink, signViaLink, viewSigningLink, viewSigningLinkDocument, SignInput } from '../../../lib/api/esignature';
import type { ExternalSigningLinkView } from '../../../lib/api/types';
import { Card, CardBody, CardHeader, CardTitle } from '../../../components/ui/Card';
import { Button } from '../../../components/ui/Button';
import { Alert } from '../../../components/ui/Alert';
import { PageSpinner } from '../../../components/ui/Spinner';
import { PoweredByFooter } from '../../../components/layout/PoweredByFooter';
import { SignaturePad } from '../../../components/esignature/SignaturePad';

/**
 * The PUBLIC, token-scoped external signing page — see
 * docs/conventions/e-signatures.md → External signing links. No
 * `AuthProvider` session, no sidebar (deliberately outside the `(app)`
 * route group, the same "unauthenticated screen lives directly under
 * `app/`" shape `/login` already establishes) — the raw token in the URL
 * is the ONLY thing that grants access. `?tenant=<slug>` (present whenever
 * the portal isn't served from a real per-tenant subdomain) is stored via
 * the SAME `setStoredTenantSlug` the login form uses, so `apiFetch`'s
 * header-based tenant resolution works here too, with no session at all.
 */
export default function ExternalSigningPage() {
  const { t } = useI18n();
  const params = useParams<{ token: string }>();
  const token = params.token;

  const [view, setView] = useState<ExternalSigningLinkView | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [expired, setExpired] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [signed, setSigned] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const tenantSlug = new URLSearchParams(window.location.search).get('tenant');
    if (tenantSlug) {
      setStoredTenantSlug(tenantSlug);
    }
    viewSigningLink(token)
      .then((result) => {
        setView(result);
        setSigned(result.status === 'SIGNED');
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 410) {
          setExpired(true);
        } else {
          setNotFound(true);
        }
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  async function handleViewDocument() {
    try {
      await viewSigningLinkDocument(token);
    } catch {
      setError(t('error.generic'));
    }
  }

  async function handleSign(input: SignInput) {
    setSubmitting(true);
    setError(null);
    try {
      await signViaLink(token, input);
      setSigned(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('error.generic'));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDecline() {
    setSubmitting(true);
    setError(null);
    try {
      await declineViaLink(token);
      setSigned(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('error.generic'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-sand-50 p-4">
      <div className="w-full max-w-lg space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>{t('esignature.external.title')}</CardTitle>
          </CardHeader>
          <CardBody className="space-y-4">
            {notFound && (
              <Alert tone="error" data-testid="external-signing-not-found">
                {t('esignature.external.notFound')}
              </Alert>
            )}
            {expired && (
              <Alert tone="error" data-testid="external-signing-expired">
                {t('esignature.external.expired')}
              </Alert>
            )}
            {!view && !notFound && !expired && <PageSpinner />}
            {view && !notFound && !expired && (
              <>
                <p className="text-sm font-semibold text-ink-900" data-testid="external-signing-title">
                  {view.requestTitle}
                </p>
                {signed ? (
                  <Alert tone="success" data-testid="external-signing-confirmation">
                    {t('esignature.external.signedConfirmation')}
                  </Alert>
                ) : (
                  <>
                    <Button variant="secondary" onClick={handleViewDocument} data-testid="external-view-document-button">
                      {t('esignature.my.viewDocument')}
                    </Button>
                    {error && <Alert tone="error">{error}</Alert>}
                    <SignaturePad submitting={submitting} onSubmit={handleSign} />
                    <button
                      type="button"
                      onClick={handleDecline}
                      className="text-sm text-coral-600 underline"
                      data-testid="external-decline-button"
                    >
                      {t('esignature.my.decline')}
                    </button>
                  </>
                )}
              </>
            )}
          </CardBody>
        </Card>
        <PoweredByFooter />
      </div>
    </div>
  );
}
