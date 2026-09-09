'use client';

import { FormEvent, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { useI18n } from '../../i18n/I18nProvider';
import { createSignatureRequest, GenerateDocumentInput, SignerInput } from '../../lib/api/esignature';
import { apiFetch, ApiError } from '../../lib/api/client';
import type { SignatureRequest } from '../../lib/api/types';
import { Button } from '../ui/Button';
import { Input, Label, Select, Textarea } from '../ui/Field';
import { Alert } from '../ui/Alert';

type DocumentSourceChoice = 'CUSTOM' | 'OFFER_LETTER' | 'POLICY' | 'UPLOAD';

let signerKeySeq = 0;
type SignerRow = Partial<SignerInput> & {
  key: number;
  signerType: 'INTERNAL' | 'EXTERNAL';
  order: number;
};

function emptySignerRow(order: number): SignerRow {
  signerKeySeq += 1;
  return { key: signerKeySeq, signerType: 'INTERNAL', order };
}

/**
 * Create-a-signature-request form — see docs/conventions/e-signatures.md.
 * Four document sources: write one now (CUSTOM), generate from an offer
 * letter or a policy (this module renders the PDF itself — see
 * `SignableDocumentPdfService`), or upload an existing file. No
 * offer/policy PICKER — same documented "no picker abstraction, type the
 * id" posture frontend-admin-console.md already holds itself to for
 * interviewer/manager pickers.
 */
export function SignatureRequestForm({ onSubmitted, onCancel }: { onSubmitted: (request: SignatureRequest) => void; onCancel: () => void }) {
  const { t } = useI18n();
  const [source, setSource] = useState<DocumentSourceChoice>('CUSTOM');
  const [title, setTitle] = useState('');
  const [paragraphs, setParagraphs] = useState('');
  const [offerId, setOfferId] = useState('');
  const [policyId, setPolicyId] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [signers, setSigners] = useState<SignerRow[]>([emptySignerRow(0)]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function updateSigner(key: number, patch: Partial<SignerRow>) {
    setSigners((rows) => rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  }
  function addSigner() {
    setSigners((rows) => [...rows, emptySignerRow(rows.length)]);
  }
  function removeSigner(key: number) {
    setSigners((rows) => (rows.length > 1 ? rows.filter((row) => row.key !== key) : rows));
  }

  function toSignerInputs(): SignerInput[] {
    return signers.map((row) =>
      row.signerType === 'INTERNAL'
        ? { signerType: 'INTERNAL', order: row.order, userId: (row.userId as string) ?? '' }
        : { signerType: 'EXTERNAL', order: row.order, externalName: (row.externalName as string) ?? '', externalEmail: (row.externalEmail as string) ?? '' },
    );
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      let request: SignatureRequest;
      if (source === 'UPLOAD') {
        if (!file) throw new Error(t('esignature.admin.uploadFile'));
        const formData = new FormData();
        formData.append('file', file);
        formData.append('title', title);
        formData.append('signersJson', JSON.stringify(toSignerInputs()));
        request = await apiFetch<SignatureRequest>('/e-signatures/requests/upload', { method: 'POST', body: formData });
      } else {
        const generate: GenerateDocumentInput =
          source === 'OFFER_LETTER'
            ? { kind: 'OFFER_LETTER', offerId }
            : source === 'POLICY'
              ? { kind: 'POLICY', policyId }
              : { kind: 'CUSTOM', title, paragraphs: paragraphs.split('\n').map((p) => p.trim()).filter((p) => p.length > 0) };
        request = await createSignatureRequest({ title: title || undefined, generate, signers: toSignerInputs() });
      }
      onSubmitted(request);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : t('error.generic'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <Label htmlFor="source">{t('esignature.admin.documentSource')}</Label>
        <Select id="source" value={source} onChange={(e) => setSource(e.target.value as DocumentSourceChoice)}>
          <option value="CUSTOM">{t('esignature.admin.sourceGenerateCustom')}</option>
          <option value="OFFER_LETTER">{t('esignature.admin.sourceGenerateOffer')}</option>
          <option value="POLICY">{t('esignature.admin.sourceGeneratePolicy')}</option>
          <option value="UPLOAD">{t('esignature.admin.sourceUpload')}</option>
        </Select>
      </div>

      {(source === 'CUSTOM' || source === 'UPLOAD') && (
        <div>
          <Label htmlFor="doc-title">{t('esignature.admin.docTitle')}</Label>
          <Input id="doc-title" value={title} onChange={(e) => setTitle(e.target.value)} required={source === 'UPLOAD'} />
        </div>
      )}
      {source === 'CUSTOM' && (
        <div>
          <Label htmlFor="doc-paragraphs">{t('esignature.admin.paragraphs')}</Label>
          <Textarea id="doc-paragraphs" rows={6} value={paragraphs} onChange={(e) => setParagraphs(e.target.value)} required />
        </div>
      )}
      {source === 'OFFER_LETTER' && (
        <div>
          <Label htmlFor="offer-id">{t('esignature.admin.offerId')}</Label>
          <Input id="offer-id" value={offerId} onChange={(e) => setOfferId(e.target.value)} required />
        </div>
      )}
      {source === 'POLICY' && (
        <div>
          <Label htmlFor="policy-id">{t('esignature.admin.policyId')}</Label>
          <Input id="policy-id" value={policyId} onChange={(e) => setPolicyId(e.target.value)} required />
        </div>
      )}
      {source === 'UPLOAD' && (
        <div>
          <Label htmlFor="doc-file">{t('esignature.admin.uploadFile')}</Label>
          <input
            id="doc-file"
            type="file"
            data-testid="signature-file-input"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="block w-full text-sm text-ink-700"
          />
        </div>
      )}

      <div className="space-y-3 border-t border-ink-100 pt-4">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium text-ink-800">{t('esignature.admin.signers')}</p>
          <Button type="button" size="sm" variant="secondary" onClick={addSigner} data-testid="add-signer-button">
            <Plus className="h-4 w-4" aria-hidden />
            {t('esignature.admin.addSigner')}
          </Button>
        </div>
        {signers.map((row) => (
          <div key={row.key} className="grid grid-cols-1 gap-2 rounded-lg border border-ink-100 p-3 sm:grid-cols-[auto_1fr_auto]" data-testid="signer-row">
            <Select
              value={row.signerType}
              onChange={(e) => updateSigner(row.key, { signerType: e.target.value as 'INTERNAL' | 'EXTERNAL' })}
              className="sm:w-40"
            >
              <option value="INTERNAL">{t('esignature.admin.signerInternal')}</option>
              <option value="EXTERNAL">{t('esignature.admin.signerExternal')}</option>
            </Select>
            {row.signerType === 'INTERNAL' ? (
              <Input
                placeholder={t('esignature.admin.signerUserId')}
                value={(row.userId as string) ?? ''}
                onChange={(e) => updateSigner(row.key, { userId: e.target.value })}
                required
              />
            ) : (
              <div className="grid grid-cols-2 gap-2">
                <Input
                  placeholder={t('esignature.admin.signerName')}
                  value={(row.externalName as string) ?? ''}
                  onChange={(e) => updateSigner(row.key, { externalName: e.target.value })}
                  required
                />
                <Input
                  placeholder={t('esignature.admin.signerEmail')}
                  type="email"
                  value={(row.externalEmail as string) ?? ''}
                  onChange={(e) => updateSigner(row.key, { externalEmail: e.target.value })}
                  required
                />
              </div>
            )}
            <div className="flex items-center gap-2">
              <Input
                type="number"
                min={0}
                title={t('esignature.admin.signerOrder')}
                value={row.order}
                onChange={(e) => updateSigner(row.key, { order: Number(e.target.value) })}
                className="w-20"
              />
              <button type="button" onClick={() => removeSigner(row.key)} className="text-ink-400 hover:text-coral-600">
                <Trash2 className="h-4 w-4" aria-hidden />
              </button>
            </div>
          </div>
        ))}
      </div>

      {error && <Alert tone="error">{error}</Alert>}

      <div className="flex justify-end gap-2 border-t border-ink-100 pt-4">
        <Button type="button" variant="secondary" onClick={onCancel}>
          {t('action.cancel')}
        </Button>
        <Button type="submit" loading={submitting} data-testid="submit-signature-request-button">
          {t('esignature.admin.create')}
        </Button>
      </div>
    </form>
  );
}
