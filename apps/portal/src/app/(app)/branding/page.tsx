'use client';

import { useState } from 'react';
import { PERMISSIONS } from '@hrm/shared';
import { useI18n } from '../../../i18n/I18nProvider';
import { useAuth } from '../../../lib/auth/AuthContext';
import { useBranding } from '../../../lib/branding/BrandingProvider';
import { useAsync } from '../../../lib/useAsync';
import {
  deleteBrandingDomain,
  getBrandingSettings,
  requestBrandingDomain,
  updateBranding,
  updateFullRebrand,
  uploadBrandingFavicon,
  uploadBrandingLogo,
} from '../../../lib/api/branding';
import { Card, CardBody, CardHeader, CardTitle } from '../../../components/ui/Card';
import { Button } from '../../../components/ui/Button';
import { Alert } from '../../../components/ui/Alert';
import { StatusBadge } from '../../../components/ui/Badge';
import { Input, Label, Textarea } from '../../../components/ui/Field';
import { PageSpinner } from '../../../components/ui/Spinner';
import { ApiError } from '../../../lib/api/client';

export default function BrandingPage() {
  const { t } = useI18n();
  const { can } = useAuth();
  const canManage = can(PERMISSIONS.BRANDING_MANAGE);

  const { data: settings, reload } = useAsync(() => (canManage ? getBrandingSettings() : Promise.resolve(null)), [canManage]);
  // The shared, app-wide branding context (sidebar/login/footer) is a
  // SEPARATE fetch from this page's own `settings` — a save/upload here
  // must explicitly `refresh()` it too, or the sidebar would only pick up
  // the change on the next login/page reload. See BrandingProvider's own
  // doc comment.
  const { refresh: refreshSharedBranding } = useBranding();

  const [form, setForm] = useState<{
    productName: string;
    primaryColor: string;
    secondaryColor: string;
    accentColor: string;
    loginHeadline: string;
    loginSubtext: string;
    emailFromName: string;
    emailFromAddress: string;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const [uploadingFavicon, setUploadingFavicon] = useState(false);
  const [domainInput, setDomainInput] = useState('');
  const [requestingDomain, setRequestingDomain] = useState(false);
  const [togglingRebrand, setTogglingRebrand] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!canManage) {
    return <Alert tone="info">{t('branding.noBrandingAccess')}</Alert>;
  }

  // Only the INITIAL load gates on a spinner — `useAsync`'s `reload()`
  // (fired after every save/upload below) flips `loading` back to true
  // while leaving the previous `settings` in place, and this page must
  // keep rendering that still-usable data (plus any success/error alert)
  // through a reload rather than replacing the whole page with a spinner,
  // which would also wipe the alert the user just triggered — the same
  // "alerts render unconditionally, only the CONTENT is spinner-gated"
  // shape billing/page.tsx already establishes for itself.
  if (!settings) {
    return <PageSpinner />;
  }

  const activeForm =
    form ?? {
      productName: settings.productName ?? '',
      primaryColor: settings.primaryColor ?? '',
      secondaryColor: settings.secondaryColor ?? '',
      accentColor: settings.accentColor ?? '',
      loginHeadline: settings.loginHeadline ?? '',
      loginSubtext: settings.loginSubtext ?? '',
      emailFromName: settings.emailFromName ?? '',
      emailFromAddress: settings.emailFromAddress ?? '',
    };

  async function handleSave() {
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      await updateBranding({
        productName: activeForm.productName.trim() || null,
        primaryColor: activeForm.primaryColor.trim() || null,
        secondaryColor: activeForm.secondaryColor.trim() || null,
        accentColor: activeForm.accentColor.trim() || null,
        loginHeadline: activeForm.loginHeadline.trim() || null,
        loginSubtext: activeForm.loginSubtext.trim() || null,
        emailFromName: activeForm.emailFromName.trim() || null,
        emailFromAddress: activeForm.emailFromAddress.trim() || null,
      });
      setMessage(t('branding.saved'));
      setForm(null);
      reload();
      refreshSharedBranding();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('error.generic'));
    } finally {
      setSaving(false);
    }
  }

  async function handleUploadLogo(file: File | undefined) {
    if (!file) return;
    setUploadingLogo(true);
    setError(null);
    try {
      await uploadBrandingLogo(file);
      reload();
      refreshSharedBranding();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('error.generic'));
    } finally {
      setUploadingLogo(false);
    }
  }

  async function handleUploadFavicon(file: File | undefined) {
    if (!file) return;
    setUploadingFavicon(true);
    setError(null);
    try {
      await uploadBrandingFavicon(file);
      reload();
      refreshSharedBranding();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('error.generic'));
    } finally {
      setUploadingFavicon(false);
    }
  }

  async function handleRequestDomain() {
    if (!domainInput.trim()) return;
    setRequestingDomain(true);
    setError(null);
    try {
      await requestBrandingDomain(domainInput.trim());
      setDomainInput('');
      setMessage(t('branding.domainRequested'));
      reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('error.generic'));
    } finally {
      setRequestingDomain(false);
    }
  }

  async function handleDeleteDomain() {
    if (!settings?.domain) return;
    setError(null);
    try {
      await deleteBrandingDomain(settings.domain.id);
      setMessage(t('branding.domainRemoved'));
      reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('error.generic'));
    }
  }

  async function handleToggleRebrand(enabled: boolean) {
    setTogglingRebrand(true);
    setError(null);
    try {
      await updateFullRebrand(enabled);
      setMessage(enabled ? t('branding.fullRebrandEnabled') : t('branding.fullRebrandDisabled'));
      reload();
      refreshSharedBranding();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('error.generic'));
    } finally {
      setTogglingRebrand(false);
    }
  }

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-ink-900">{t('branding.title')}</h1>
        <p className="mt-1 text-sm text-ink-500">{t('branding.subtitle')}</p>
      </div>

      {error && <Alert tone="error">{error}</Alert>}
      {message && <Alert tone="success">{message}</Alert>}

      <Card>
        <CardHeader>
          <CardTitle>{t('branding.title')}</CardTitle>
        </CardHeader>
        <CardBody className="space-y-4">
          <div className="flex flex-wrap gap-6">
            <div>
              <Label>{t('branding.logo')}</Label>
              <div className="flex items-center gap-3">
                <div
                  className="flex h-12 w-12 items-center justify-center rounded-lg border border-ink-200 bg-sand-50 text-xs text-ink-400"
                  data-testid="branding-logo-indicator"
                  data-uploaded={settings.hasLogo}
                >
                  {settings.hasLogo ? '✓' : '—'}
                </div>
                <label className="cursor-pointer">
                  <span className="inline-flex items-center rounded-lg border border-ink-200 px-3 py-1.5 text-sm font-medium text-ink-700 hover:bg-sand-50">
                    {uploadingLogo ? '…' : settings.hasLogo ? t('branding.replace') : t('branding.upload')}
                  </span>
                  <input
                    type="file"
                    accept="image/*"
                    className="hidden"
                    disabled={uploadingLogo}
                    onChange={(e) => void handleUploadLogo(e.target.files?.[0])}
                    data-testid="branding-logo-input"
                  />
                </label>
              </div>
            </div>
            <div>
              <Label>{t('branding.favicon')}</Label>
              <div className="flex items-center gap-3">
                <div className="flex h-12 w-12 items-center justify-center rounded-lg border border-ink-200 bg-sand-50 text-xs text-ink-400">
                  {settings.hasFavicon ? '✓' : '—'}
                </div>
                <label className="cursor-pointer">
                  <span className="inline-flex items-center rounded-lg border border-ink-200 px-3 py-1.5 text-sm font-medium text-ink-700 hover:bg-sand-50">
                    {uploadingFavicon ? '…' : settings.hasFavicon ? t('branding.replace') : t('branding.upload')}
                  </span>
                  <input
                    type="file"
                    accept="image/*"
                    className="hidden"
                    disabled={uploadingFavicon}
                    onChange={(e) => void handleUploadFavicon(e.target.files?.[0])}
                    data-testid="branding-favicon-input"
                  />
                </label>
              </div>
            </div>
          </div>

          <div>
            <Label htmlFor="branding-product-name">{t('branding.productName')}</Label>
            <Input
              id="branding-product-name"
              placeholder={t('branding.productNamePlaceholder')}
              value={activeForm.productName}
              onChange={(e) => setForm({ ...activeForm, productName: e.target.value })}
              data-testid="branding-product-name-input"
            />
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <Label htmlFor="branding-primary-color">{t('branding.primaryColor')}</Label>
              <Input
                id="branding-primary-color"
                placeholder="#0f766e"
                value={activeForm.primaryColor}
                onChange={(e) => setForm({ ...activeForm, primaryColor: e.target.value })}
                data-testid="branding-primary-color-input"
              />
            </div>
            <div>
              <Label htmlFor="branding-secondary-color">{t('branding.secondaryColor')}</Label>
              <Input
                id="branding-secondary-color"
                placeholder="#0369a1"
                value={activeForm.secondaryColor}
                onChange={(e) => setForm({ ...activeForm, secondaryColor: e.target.value })}
              />
            </div>
            <div>
              <Label htmlFor="branding-accent-color">{t('branding.accentColor')}</Label>
              <Input
                id="branding-accent-color"
                placeholder="#f59e0b"
                value={activeForm.accentColor}
                onChange={(e) => setForm({ ...activeForm, accentColor: e.target.value })}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="branding-login-headline">{t('branding.loginHeadline')}</Label>
              <Input
                id="branding-login-headline"
                value={activeForm.loginHeadline}
                onChange={(e) => setForm({ ...activeForm, loginHeadline: e.target.value })}
              />
            </div>
            <div>
              <Label htmlFor="branding-login-subtext">{t('branding.loginSubtext')}</Label>
              <Textarea
                id="branding-login-subtext"
                rows={1}
                value={activeForm.loginSubtext}
                onChange={(e) => setForm({ ...activeForm, loginSubtext: e.target.value })}
              />
            </div>
          </div>

          <div className="border-t border-ink-100 pt-4">
            <p className="mb-2 text-sm font-medium text-ink-700">{t('branding.emailIdentity')}</p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="branding-email-from-name">{t('branding.emailFromName')}</Label>
                <Input
                  id="branding-email-from-name"
                  value={activeForm.emailFromName}
                  onChange={(e) => setForm({ ...activeForm, emailFromName: e.target.value })}
                />
              </div>
              <div>
                <Label htmlFor="branding-email-from-address">{t('branding.emailFromAddress')}</Label>
                <Input
                  id="branding-email-from-address"
                  type="email"
                  value={activeForm.emailFromAddress}
                  onChange={(e) => setForm({ ...activeForm, emailFromAddress: e.target.value })}
                />
              </div>
            </div>
          </div>

          <div className="flex justify-end border-t border-ink-100 pt-4">
            <Button onClick={handleSave} loading={saving} data-testid="branding-save-button">
              {t('branding.save')}
            </Button>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('branding.customDomain')}</CardTitle>
        </CardHeader>
        <CardBody className="space-y-4">
          <p className="text-sm text-ink-500">{t('branding.customDomainHint')}</p>
          {settings.domain ? (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-4 text-sm">
                <span className="font-medium text-ink-800">{settings.domain.domain}</span>
                <StatusBadge status={settings.domain.verificationStatus} label={t(`branding.domainStatus.${settings.domain.verificationStatus}`)} />
                <StatusBadge status={settings.domain.certStatus} label={t(`branding.certStatus.${settings.domain.certStatus}`)} />
              </div>
              {settings.domain.verificationStatus === 'PENDING_VERIFICATION' && (
                <Alert tone="info">
                  <div className="space-y-1">
                    <p>{t('branding.dnsInstructions')}</p>
                    <p className="font-mono text-xs">
                      {t('branding.dnsRecordName')}: {`_hrm-verify.${settings.domain.domain}`}
                    </p>
                  </div>
                </Alert>
              )}
              <Button variant="secondary" size="sm" onClick={() => void handleDeleteDomain()}>
                {t('branding.deleteDomain')}
              </Button>
            </div>
          ) : (
            <div className="flex items-end gap-3">
              <div className="flex-1">
                <Label htmlFor="branding-domain">{t('branding.customDomain')}</Label>
                <Input
                  id="branding-domain"
                  placeholder={t('branding.domainPlaceholder')}
                  value={domainInput}
                  onChange={(e) => setDomainInput(e.target.value)}
                  data-testid="branding-domain-input"
                />
              </div>
              <Button onClick={handleRequestDomain} loading={requestingDomain} disabled={!domainInput.trim()} data-testid="branding-domain-request-button">
                {t('branding.requestDomain')}
              </Button>
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('branding.fullRebrand')}</CardTitle>
        </CardHeader>
        <CardBody className="space-y-3">
          <p className="text-sm text-ink-500">{t('branding.fullRebrandHint')}</p>
          {!settings.fullRebrandEntitled && <Alert tone="info">{t('branding.fullRebrandNotEntitled')}</Alert>}
          <label className="flex items-center gap-2 text-sm text-ink-700">
            <input
              type="checkbox"
              checked={settings.fullRebrandEnabled}
              disabled={!settings.fullRebrandEntitled || togglingRebrand}
              onChange={(e) => void handleToggleRebrand(e.target.checked)}
              data-testid="branding-full-rebrand-toggle"
            />
            {t('branding.fullRebrand')}
          </label>
        </CardBody>
      </Card>
    </div>
  );
}
