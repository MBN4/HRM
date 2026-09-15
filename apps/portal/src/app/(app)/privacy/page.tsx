'use client';

import { useState } from 'react';
import { PERMISSIONS } from '@hrm/shared';
import { useI18n } from '../../../i18n/I18nProvider';
import { useAuth } from '../../../lib/auth/AuthContext';
import { useAsync } from '../../../lib/useAsync';
import {
  createDataSubjectRequest,
  downloadDataSubjectExport,
  listDataSubjectRequests,
  listEffectiveRetentionPolicies,
  listProcessingRegister,
  listSubProcessors,
  removeTenantRetentionOverride,
  setTenantRetentionOverride,
  type DataCategory,
  type DataSubjectType,
  type PrivacyRequestType,
} from '../../../lib/api/privacy';
import { Card, CardBody, CardHeader, CardTitle } from '../../../components/ui/Card';
import { Button } from '../../../components/ui/Button';
import { Alert } from '../../../components/ui/Alert';
import { EmptyState } from '../../../components/ui/EmptyState';
import { PageSpinner } from '../../../components/ui/Spinner';
import { Select, Label, Input, Textarea } from '../../../components/ui/Field';
import { StatusBadge } from '../../../components/ui/Badge';

const SUBJECT_TYPES: DataSubjectType[] = ['EMPLOYEE', 'CANDIDATE', 'USER'];
const REQUEST_TYPES: PrivacyRequestType[] = ['EXPORT', 'ERASURE'];

export default function PrivacyPage() {
  const { t } = useI18n();
  const { can } = useAuth();
  const canManage = can(PERMISSIONS.PRIVACY_MANAGE);

  const [requestType, setRequestType] = useState<PrivacyRequestType>('EXPORT');
  const [subjectType, setSubjectType] = useState<DataSubjectType>('EMPLOYEE');
  const [subjectId, setSubjectId] = useState('');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [overrideDraft, setOverrideDraft] = useState<Record<string, string>>({});

  const { data: requests, loading: requestsLoading, reload: reloadRequests } = useAsync(
    () => (canManage ? listDataSubjectRequests() : Promise.resolve([])),
    [canManage],
  );
  const { data: register } = useAsync(() => (canManage ? listProcessingRegister() : Promise.resolve([])), [canManage]);
  const { data: subProcessors } = useAsync(() => (canManage ? listSubProcessors() : Promise.resolve([])), [canManage]);
  const { data: retentionPolicies, reload: reloadRetention } = useAsync(
    () => (canManage ? listEffectiveRetentionPolicies() : Promise.resolve([])),
    [canManage],
  );

  if (!canManage) {
    return <Alert tone="info">{t('privacy.noAccess')}</Alert>;
  }

  async function handleSubmit() {
    if (!subjectId) return;
    setSubmitting(true);
    try {
      await createDataSubjectRequest({ requestType, subjectType, subjectId, reason: reason || undefined });
      setSubjectId('');
      setReason('');
      reloadRequests();
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSetOverride(category: DataCategory) {
    const value = Number(overrideDraft[category]);
    if (!value || value < 1) return;
    await setTenantRetentionOverride(category, value);
    reloadRetention();
  }

  async function handleRemoveOverride(category: DataCategory) {
    await removeTenantRetentionOverride(category);
    reloadRetention();
  }

  return (
    <div className="max-w-4xl space-y-6">
      <h1 className="text-xl font-semibold text-ink-900">{t('privacy.title')}</h1>
      <p className="text-sm text-ink-500">{t('privacy.subtitle')}</p>

      <Card>
        <CardHeader>
          <CardTitle>{t('privacy.newRequest')}</CardTitle>
        </CardHeader>
        <CardBody className="space-y-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div>
              <Label htmlFor="pr-type">{t('privacy.requestType')}</Label>
              <Select id="pr-type" value={requestType} onChange={(e) => setRequestType(e.target.value as PrivacyRequestType)}>
                {REQUEST_TYPES.map((rt) => (
                  <option key={rt} value={rt}>
                    {t(`privacy.requestType.${rt}`)}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label htmlFor="pr-subject-type">{t('privacy.subjectType')}</Label>
              <Select id="pr-subject-type" value={subjectType} onChange={(e) => setSubjectType(e.target.value as DataSubjectType)}>
                {SUBJECT_TYPES.map((st) => (
                  <option key={st} value={st}>
                    {t(`privacy.subjectType.${st}`)}
                  </option>
                ))}
              </Select>
            </div>
            <div className="sm:col-span-2">
              <Label htmlFor="pr-subject-id">{t('privacy.subjectId')}</Label>
              <Input id="pr-subject-id" value={subjectId} onChange={(e) => setSubjectId(e.target.value)} placeholder={t('privacy.subjectIdPlaceholder')} data-testid="privacy-subject-id-input" />
            </div>
          </div>
          <div>
            <Label htmlFor="pr-reason">{t('privacy.reason')}</Label>
            <Textarea id="pr-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} />
          </div>
          <Button onClick={handleSubmit} disabled={!subjectId || submitting} data-testid="privacy-submit-request-button">
            {t('privacy.submit')}
          </Button>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('privacy.requestHistory')}</CardTitle>
          <Button variant="secondary" size="sm" onClick={() => reloadRequests()}>
            {t('privacy.refresh')}
          </Button>
        </CardHeader>
        <CardBody>
          {requestsLoading ? (
            <PageSpinner />
          ) : !requests || requests.length === 0 ? (
            <EmptyState title={t('privacy.noRequests')} />
          ) : (
            <ul className="divide-y divide-ink-100" data-testid="privacy-request-history">
              {requests.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                  <div>
                    <p className="font-medium text-ink-800">
                      {t(`privacy.requestType.${r.requestType}`)} — {t(`privacy.subjectType.${r.subjectType}`)} ({r.subjectId.slice(0, 8)}…)
                    </p>
                    <p className="text-xs text-ink-400">{new Date(r.createdAt).toLocaleString()}</p>
                    {r.failureReason && <p className="text-xs text-red-600">{r.failureReason}</p>}
                    {r.erasureSummary && (
                      <p className="text-xs text-ink-400">
                        {t('privacy.erasureSummary')}: {Object.entries(r.erasureSummary).map(([cat, s]) => `${cat}: ${s.action}`).join(', ')}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <StatusBadge status={r.status} label={t(`privacy.status.${r.status}`)} />
                    {r.requestType === 'EXPORT' && r.status === 'COMPLETED' && (
                      <Button variant="ghost" size="sm" onClick={() => downloadDataSubjectExport(r.id)}>
                        {t('privacy.downloadExport')}
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('privacy.retentionPolicy')}</CardTitle>
        </CardHeader>
        <CardBody>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase text-ink-400">
                  <th className="py-2">{t('privacy.category')}</th>
                  <th className="py-2">{t('privacy.action')}</th>
                  <th className="py-2">{t('privacy.retentionMonths')}</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {(retentionPolicies ?? []).map((policy) => (
                  <tr key={policy.category}>
                    <td className="py-2 font-medium text-ink-800">{policy.category}</td>
                    <td className="py-2 text-ink-600">{policy.action}</td>
                    <td className="py-2 text-ink-600">
                      {policy.retentionMonths}
                      {policy.tenantOverrideApplied && <span className="ms-1 text-xs text-brand-600">({t('privacy.tenantOverride')})</span>}
                    </td>
                    <td className="py-2">
                      <div className="flex items-center gap-1">
                        <Input
                          type="number"
                          min={1}
                          className="w-20"
                          value={overrideDraft[policy.category] ?? ''}
                          onChange={(e) => setOverrideDraft((prev) => ({ ...prev, [policy.category]: e.target.value }))}
                        />
                        <Button variant="ghost" size="sm" onClick={() => handleSetOverride(policy.category)}>
                          {t('privacy.setOverride')}
                        </Button>
                        {policy.tenantOverrideApplied && (
                          <Button variant="ghost" size="sm" onClick={() => handleRemoveOverride(policy.category)}>
                            {t('privacy.removeOverride')}
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('privacy.processingRegister')}</CardTitle>
        </CardHeader>
        <CardBody>
          <ul className="space-y-3" data-testid="privacy-processing-register">
            {(register ?? []).map((entry) => (
              <li key={entry.category} className="text-sm">
                <p className="font-medium text-ink-800">{entry.category}</p>
                <p className="text-ink-600">{entry.description}</p>
                <p className="text-xs text-ink-400">
                  {t('privacy.purpose')}: {entry.purposeOfProcessing} · {t('privacy.legalBasis')}: {entry.legalBasis}
                </p>
              </li>
            ))}
          </ul>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('privacy.subProcessors')}</CardTitle>
        </CardHeader>
        <CardBody>
          <ul className="space-y-2" data-testid="privacy-sub-processors">
            {(subProcessors ?? []).map((sp) => (
              <li key={sp.id} className="text-sm">
                <span className="font-medium text-ink-800">{sp.name}</span> — <span className="text-ink-600">{sp.purpose}</span>{' '}
                <span className="text-xs text-ink-400">({sp.region})</span>
              </li>
            ))}
          </ul>
        </CardBody>
      </Card>
    </div>
  );
}
