import { apiFetch, apiFetchBlob } from './client';
import { triggerBrowserDownload } from '../download';
import type {
  DocumentIntegrityCheck,
  ExternalSigningLinkView,
  SignatureEvent,
  SignatureRequest,
  SignatureSigner,
  SigningMethod,
} from './types';

/** Fetches a blob and opens it in a new tab (object URL) — for VIEWING a document before deciding to sign it, unlike `triggerBrowserDownload`'s save-as behavior. */
async function openBlobInNewTab(fetchBlob: () => ReturnType<typeof apiFetchBlob>): Promise<void> {
  const { blob } = await fetchBlob();
  const url = URL.createObjectURL(blob);
  window.open(url, '_blank', 'noopener,noreferrer');
  // Revoked after a delay, not immediately — the new tab needs time to
  // actually load the object URL before it's freed.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export type SignerInput =
  | { signerType: 'INTERNAL'; order: number; userId: string }
  | { signerType: 'EXTERNAL'; order: number; externalName: string; externalEmail: string };

export type GenerateDocumentInput =
  | { kind: 'OFFER_LETTER'; offerId: string }
  | { kind: 'POLICY'; policyId: string }
  | { kind: 'CUSTOM'; title: string; paragraphs: string[] };

export interface CreateGeneratedSignatureRequestInput {
  title?: string;
  entityType?: string;
  entityId?: string;
  branchId?: string;
  generate: GenerateDocumentInput;
  signers: SignerInput[];
  expiresInDays?: number;
}

export type SignInput =
  | { signingMethod: 'TYPED_NAME'; typedSignatureText: string; consent: true }
  | { signingMethod: 'DRAWN_SIGNATURE'; signatureImageBase64: string; consent: true }
  | { signingMethod: 'CLICK_TO_SIGN'; consent: true };

export function createSignatureRequest(input: CreateGeneratedSignatureRequestInput): Promise<SignatureRequest> {
  return apiFetch<SignatureRequest>('/e-signatures/requests', { method: 'POST', body: input });
}

export function listSignatureRequests(filters: { status?: string; entityType?: string } = {}): Promise<SignatureRequest[]> {
  return apiFetch<SignatureRequest[]>('/e-signatures/requests', { query: filters });
}

export function getSignatureRequest(id: string): Promise<SignatureRequest> {
  return apiFetch<SignatureRequest>(`/e-signatures/requests/${id}`);
}

export function sendSignatureRequest(id: string): Promise<SignatureRequest> {
  return apiFetch<SignatureRequest>(`/e-signatures/requests/${id}/send`, { method: 'POST' });
}

export function cancelSignatureRequest(id: string): Promise<SignatureRequest> {
  return apiFetch<SignatureRequest>(`/e-signatures/requests/${id}/cancel`, { method: 'POST' });
}

export function getSignatureRequestEvents(id: string): Promise<SignatureEvent[]> {
  return apiFetch<SignatureEvent[]>(`/e-signatures/requests/${id}/events`);
}

export function verifySignatureRequestIntegrity(id: string): Promise<DocumentIntegrityCheck> {
  return apiFetch<DocumentIntegrityCheck>(`/e-signatures/requests/${id}/verify`);
}

export async function downloadSignatureRequestDocument(id: string): Promise<void> {
  const { blob, filename } = await apiFetchBlob(`/e-signatures/requests/${id}/document`);
  triggerBrowserDownload(blob, filename ?? `signature-request-${id}-document`);
}

export async function downloadSignatureCertificate(id: string): Promise<void> {
  const { blob, filename } = await apiFetchBlob(`/e-signatures/requests/${id}/certificate`);
  triggerBrowserDownload(blob, filename ?? `signature-request-${id}-certificate.pdf`);
}

// --- Internal (ESS) self-service signing ---------------------------------

export function myPendingSignatures(): Promise<SignatureSigner[]> {
  return apiFetch<SignatureSigner[]>('/e-signatures/my-pending');
}

export function viewMySignatureDocument(signerId: string): Promise<void> {
  return openBlobInNewTab(() => apiFetchBlob(`/e-signatures/my-signatures/${signerId}/document`));
}

export function signMine(signerId: string, input: SignInput): Promise<SignatureSigner> {
  return apiFetch<SignatureSigner>(`/e-signatures/my-signatures/${signerId}/sign`, { method: 'POST', body: input });
}

export function declineMine(signerId: string, reason?: string): Promise<SignatureSigner> {
  return apiFetch<SignatureSigner>(`/e-signatures/my-signatures/${signerId}/decline`, { method: 'POST', body: { reason } });
}

// --- External (public, token-scoped) signing ------------------------------
//
// No Authorization header, ever — these hit the API's `@AllowAnonymous()`
// external-signing controller directly via the token alone (see
// docs/conventions/e-signatures.md). `apiFetch`/`apiFetchBlob` still attach
// the tenant header when one is stored (see the `/esign/[token]` page,
// which stores the `?tenant=` query param first) — that's tenant
// RESOLUTION, not authentication.

export function viewSigningLink(token: string): Promise<ExternalSigningLinkView> {
  return apiFetch<ExternalSigningLinkView>(`/e-signatures/sign/${token}`);
}

export function viewSigningLinkDocument(token: string): Promise<void> {
  return openBlobInNewTab(() => apiFetchBlob(`/e-signatures/sign/${token}/document`));
}

export function signViaLink(token: string, input: SignInput): Promise<SignatureSigner> {
  return apiFetch<SignatureSigner>(`/e-signatures/sign/${token}`, { method: 'POST', body: input });
}

export function declineViaLink(token: string, reason?: string): Promise<SignatureSigner> {
  return apiFetch<SignatureSigner>(`/e-signatures/sign/${token}/decline`, { method: 'POST', body: { reason } });
}

export const SIGNING_METHOD_LABELS: Record<SigningMethod, string> = {
  TYPED_NAME: 'Typed name',
  DRAWN_SIGNATURE: 'Drawn signature',
  CLICK_TO_SIGN: 'Click to sign',
};
