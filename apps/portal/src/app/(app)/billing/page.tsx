'use client';

import { useState } from 'react';
import { PERMISSIONS } from '@hrm/shared';
import { useI18n } from '../../../i18n/I18nProvider';
import { useAuth } from '../../../lib/auth/AuthContext';
import { useAsync } from '../../../lib/useAsync';
import {
  attachBillingPaymentMethod,
  cancelBillingSubscription,
  changeBillingPlan,
  getBillingSummary,
  removeBillingPaymentMethod,
} from '../../../lib/api/billing';
import { formatCurrency, formatDate } from '../../../lib/format';
import { Card, CardBody, CardHeader, CardTitle } from '../../../components/ui/Card';
import { Button } from '../../../components/ui/Button';
import { Alert } from '../../../components/ui/Alert';
import { StatusBadge } from '../../../components/ui/Badge';
import { Input, Label, Select } from '../../../components/ui/Field';
import { EmptyState } from '../../../components/ui/EmptyState';
import { PageSpinner } from '../../../components/ui/Spinner';
import type { TenantEdition } from '../../../lib/api/types';
import { ApiError } from '../../../lib/api/client';

const EDITIONS: TenantEdition[] = ['STARTER', 'PROFESSIONAL', 'ENTERPRISE'];

export default function BillingPage() {
  const { t, locale } = useI18n();
  const { can } = useAuth();
  const canManage = can(PERMISSIONS.BILLING_MANAGE);

  const { data: summary, loading, reload } = useAsync(() => (canManage ? getBillingSummary() : Promise.resolve(null)), [canManage]);

  const [selectedEdition, setSelectedEdition] = useState<TenantEdition | ''>('');
  const [changingPlan, setChangingPlan] = useState(false);
  const [prorationMessage, setProrationMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paymentToken, setPaymentToken] = useState('');
  const [addingPaymentMethod, setAddingPaymentMethod] = useState(false);

  if (!canManage) {
    return <Alert tone="info">{t('billing.noBillingAccess')}</Alert>;
  }

  async function handleChangePlan() {
    if (!selectedEdition) return;
    setChangingPlan(true);
    setError(null);
    setProrationMessage(null);
    try {
      const result = await changeBillingPlan(selectedEdition);
      setProrationMessage(t('billing.prorationPreview', { amount: formatCurrency(Number(result.prorationPreviewMinorUnits) / 100, summary?.subscription.currency?.toUpperCase(), locale) }));
      setSelectedEdition('');
      reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('error.generic'));
    } finally {
      setChangingPlan(false);
    }
  }

  async function handleCancel() {
    if (!window.confirm(t('billing.cancelAtPeriodEndConfirm'))) return;
    setError(null);
    try {
      await cancelBillingSubscription(true);
      reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('error.generic'));
    }
  }

  async function handleAddPaymentMethod() {
    if (!paymentToken.trim()) return;
    setAddingPaymentMethod(true);
    setError(null);
    try {
      await attachBillingPaymentMethod(paymentToken.trim(), true);
      setPaymentToken('');
      reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('error.generic'));
    } finally {
      setAddingPaymentMethod(false);
    }
  }

  async function handleRemovePaymentMethod(id: string) {
    setError(null);
    try {
      await removeBillingPaymentMethod(id);
      reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('error.generic'));
    }
  }

  return (
    <div className="max-w-3xl space-y-6">
      <h1 className="text-xl font-semibold text-ink-900">{t('billing.title')}</h1>

      {error && <Alert tone="error">{error}</Alert>}
      {prorationMessage && <Alert tone="info">{prorationMessage}</Alert>}

      {loading || !summary ? (
        <PageSpinner />
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle>{t('billing.currentPlan')}</CardTitle>
            </CardHeader>
            <CardBody className="space-y-4">
              <div className="flex flex-wrap items-center gap-x-8 gap-y-3 text-sm">
                <div>
                  <p className="text-ink-400">{t('billing.currentPlan')}</p>
                  <p className="font-medium text-ink-800">{t(`billing.edition.${summary.subscription.edition}`)}</p>
                </div>
                <div>
                  <p className="text-ink-400">{t('billing.status')}</p>
                  <StatusBadge status={summary.subscription.status} label={t(`billing.status.${summary.subscription.status}`)} />
                </div>
                <div>
                  <p className="text-ink-400">{t('billing.seats')}</p>
                  <p className="font-medium text-ink-800">
                    {t('billing.seatsInUse', { active: summary.activeSeats, quantity: summary.subscription.quantity ?? summary.activeSeats })}
                  </p>
                </div>
                {summary.subscription.currentPeriodEnd && (
                  <div>
                    <p className="text-ink-400">{t('billing.currentPeriodEnd')}</p>
                    <p className="font-medium text-ink-800">{formatDate(summary.subscription.currentPeriodEnd, locale)}</p>
                  </div>
                )}
                {summary.subscription.trialEndsAt && (
                  <div>
                    <p className="text-ink-400">{t('billing.trialEndsAt')}</p>
                    <p className="font-medium text-ink-800">{formatDate(summary.subscription.trialEndsAt, locale)}</p>
                  </div>
                )}
              </div>

              {summary.subscription.cancelAtPeriodEnd && <Alert tone="info">{t('billing.cancelAtPeriodEnd')}</Alert>}

              <div className="flex flex-wrap items-end gap-3 border-t border-ink-100 pt-4">
                <div className="w-48">
                  <Label htmlFor="billing-edition">{t('billing.selectEdition')}</Label>
                  <Select id="billing-edition" value={selectedEdition} onChange={(e) => setSelectedEdition(e.target.value as TenantEdition)}>
                    <option value="">{t('billing.selectEdition')}</option>
                    {EDITIONS.map((edition) => (
                      <option key={edition} value={edition}>
                        {t(`billing.edition.${edition}`)}
                      </option>
                    ))}
                  </Select>
                </div>
                <Button onClick={handleChangePlan} loading={changingPlan} disabled={!selectedEdition}>
                  {t('billing.changePlan')}
                </Button>
                {summary.subscription.status !== 'CANCELED' && !summary.subscription.cancelAtPeriodEnd && (
                  <Button variant="danger" onClick={handleCancel}>
                    {t('billing.cancelSubscription')}
                  </Button>
                )}
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t('billing.paymentMethods')}</CardTitle>
            </CardHeader>
            <CardBody className="space-y-4">
              {summary.paymentMethods.length === 0 ? (
                <EmptyState title={t('billing.noPaymentMethod')} />
              ) : (
                <ul className="divide-y divide-ink-100">
                  {summary.paymentMethods.map((pm) => (
                    <li key={pm.id} className="flex items-center justify-between py-2.5 text-sm">
                      <div>
                        <span className="font-medium text-ink-800">{t('billing.cardBrandLast4', { brand: pm.brand ?? '—', last4: pm.last4 ?? '····' })}</span>
                        {pm.expMonth && pm.expYear && (
                          <span className="ms-2 text-ink-400">{t('billing.expires', { month: pm.expMonth, year: pm.expYear })}</span>
                        )}
                        {pm.isDefault && (
                          <span className="ms-2">
                            <StatusBadge status="ACTIVE" label={t('billing.default')} />
                          </span>
                        )}
                      </div>
                      <Button variant="secondary" size="sm" onClick={() => void handleRemovePaymentMethod(pm.id)}>
                        {t('billing.remove')}
                      </Button>
                    </li>
                  ))}
                </ul>
              )}

              <div className="flex items-end gap-3 border-t border-ink-100 pt-4">
                <div className="flex-1">
                  <Label htmlFor="payment-token">{t('billing.addPaymentMethod')}</Label>
                  <Input
                    id="payment-token"
                    placeholder="pm_card_visa"
                    value={paymentToken}
                    onChange={(e) => setPaymentToken(e.target.value)}
                  />
                </div>
                <Button onClick={handleAddPaymentMethod} loading={addingPaymentMethod} disabled={!paymentToken.trim()}>
                  {t('billing.addPaymentMethod')}
                </Button>
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t('billing.invoices')}</CardTitle>
            </CardHeader>
            <CardBody>
              {summary.invoices.length === 0 ? (
                <EmptyState title={t('billing.noInvoices')} />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-start text-sm">
                    <thead>
                      <tr className="border-b border-ink-100 text-xs uppercase tracking-wide text-ink-400">
                        <th className="py-2 text-start font-medium">{t('common.status')}</th>
                        <th className="py-2 text-start font-medium">{t('payroll.currency')}</th>
                        <th className="py-2 text-start font-medium">{t('billing.invoices')}</th>
                        <th className="py-2 text-start font-medium" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-ink-100">
                      {summary.invoices.map((invoice) => (
                        <tr key={invoice.id}>
                          <td className="py-2.5">
                            <StatusBadge status={invoice.status} label={t(`billing.invoice.status.${invoice.status}`)} />
                          </td>
                          <td className="py-2.5 text-ink-600">{formatCurrency(Number(invoice.amountDue), invoice.currency.toUpperCase(), locale)}</td>
                          <td className="py-2.5 text-ink-600">{t(`billing.invoice.type.${invoice.type}`)}</td>
                          <td className="py-2.5 text-end">
                            {invoice.hostedInvoiceUrl && (
                              <a href={invoice.hostedInvoiceUrl} target="_blank" rel="noreferrer" className="text-brand-600 hover:underline">
                                {t('billing.viewInvoice')}
                              </a>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardBody>
          </Card>
        </>
      )}
    </div>
  );
}
