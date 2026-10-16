import { apiFetch, apiFetchBlob } from './client';

/** Legal-entity administration (step 12.1) — mirrors `/legal-entities/*` (JWT + `entity.manage`). */
export interface LegalEntityBranch {
  id: string;
  name: string;
  countryCode: string;
}

export interface LegalEntity {
  id: string;
  legalName: string;
  countryCode: string;
  registrationNumber: string | null;
  taxId: string | null;
  /** Country-Pack-driven display labels for the two generic identifiers. */
  registrationNumberLabel: string;
  taxIdLabel: string;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  addressLines: string[];
  hasLogo: boolean;
  isDefault: boolean;
  hasBankDetails: boolean;
  /** OMITTED by the API for a caller without `salary.view`; always the masked form. */
  bankDetails?: {
    bankName: string | null;
    accountNumberMasked: string;
    routingCodeMasked: string | null;
  } | null;
  branchCount: number;
  branches?: LegalEntityBranch[];
  createdAt: string;
  updatedAt: string;
}

export interface LegalEntityEmployee {
  id: string;
  employeeCode: string;
  name: string;
  status: string;
  branchId: string;
  branchName: string;
}

export interface LegalEntityInput {
  legalName?: string;
  countryCode?: string;
  registrationNumber?: string | null;
  taxId?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  region?: string | null;
  postalCode?: string | null;
  /** `null` clears; omitted leaves untouched. */
  bankDetails?: { bankName: string; accountNumber: string; routingCode?: string | null } | null;
}

export const listLegalEntities = () => apiFetch<LegalEntity[]>('/legal-entities');
export const createLegalEntity = (input: LegalEntityInput) =>
  apiFetch<LegalEntity>('/legal-entities', { method: 'POST', body: input });
export const updateLegalEntity = (id: string, input: LegalEntityInput) =>
  apiFetch<LegalEntity>(`/legal-entities/${id}`, { method: 'PATCH', body: input });
export const deleteLegalEntity = (id: string) =>
  apiFetch<{ deleted: true }>(`/legal-entities/${id}`, { method: 'DELETE' });
export const setDefaultLegalEntity = (id: string) =>
  apiFetch<LegalEntity>(`/legal-entities/${id}/default`, { method: 'POST' });
export const assignLegalEntityBranches = (id: string, branchIds: string[]) =>
  apiFetch<LegalEntity>(`/legal-entities/${id}/branches`, { method: 'PUT', body: { branchIds } });
export const listLegalEntityEmployees = (id: string) =>
  apiFetch<LegalEntityEmployee[]>(`/legal-entities/${id}/employees`);

export async function uploadLegalEntityLogo(id: string, file: File): Promise<LegalEntity> {
  const form = new FormData();
  form.append('file', file);
  return apiFetch<LegalEntity>(`/legal-entities/${id}/logo`, { method: 'POST', body: form });
}

/** The logo needs the Authorization header, so it is fetched as a blob and shown via an object URL. */
export async function fetchLegalEntityLogoUrl(id: string): Promise<string> {
  const { blob } = await apiFetchBlob(`/legal-entities/${id}/logo`);
  return URL.createObjectURL(blob);
}
