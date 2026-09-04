import { apiFetch } from './client';
import type { BillingSummary, ChangePlanResult, PaymentMethodSummary, TenantEdition } from './types';

export function getBillingSummary(): Promise<BillingSummary> {
  return apiFetch<BillingSummary>('/billing/summary');
}

export function changeBillingPlan(edition: TenantEdition): Promise<ChangePlanResult> {
  return apiFetch<ChangePlanResult>('/billing/plan', { method: 'POST', body: { edition } });
}

export function cancelBillingSubscription(atPeriodEnd = true): Promise<{ status: string }> {
  return apiFetch('/billing/cancel', { method: 'POST', body: { atPeriodEnd } });
}

export function createBillingSetupIntent(): Promise<{ clientSecret: string }> {
  return apiFetch('/billing/setup-intent', { method: 'POST' });
}

export function attachBillingPaymentMethod(paymentMethodId: string, setAsDefault = false): Promise<PaymentMethodSummary> {
  return apiFetch<PaymentMethodSummary>('/billing/payment-methods', { method: 'POST', body: { paymentMethodId, setAsDefault } });
}

export function removeBillingPaymentMethod(id: string): Promise<void> {
  return apiFetch(`/billing/payment-methods/${id}`, { method: 'DELETE' });
}
