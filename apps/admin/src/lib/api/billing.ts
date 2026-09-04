import { apiFetch } from './client';
import type { InvoiceSummary, PlatformSubscriptionSummary, TenantBillingSummary } from './types';

export function listSubscriptions(): Promise<PlatformSubscriptionSummary[]> {
  return apiFetch('/platform/billing/subscriptions');
}

export function getTenantBilling(tenantId: string): Promise<TenantBillingSummary> {
  return apiFetch(`/platform/billing/tenants/${tenantId}`);
}

export interface CreateAmcInvoiceInput {
  amountMinorUnits: number;
  currency: string;
  description: string;
  dueInDays?: number;
}

export function createAmcInvoice(tenantId: string, input: CreateAmcInvoiceInput): Promise<InvoiceSummary> {
  return apiFetch(`/platform/billing/tenants/${tenantId}/amc-invoices`, { method: 'POST', body: input });
}

export function resyncSubscription(tenantId: string): Promise<unknown> {
  return apiFetch(`/platform/billing/tenants/${tenantId}/resync`, { method: 'POST' });
}
