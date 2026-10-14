'use client';

import { FormEvent, useRef, useState } from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import { ApiError } from '../../lib/api/client';
import { addApplicant } from '../../lib/api/screening';
import { Alert } from '../ui/Alert';
import { Button } from '../ui/Button';
import { Input, Label, Select } from '../ui/Field';

/** A recruiter adds an applicant (optionally with a resume) to one of the requisition's postings — the internal twin of the public careers apply form. The resume is parsed in the background after this returns. */
export function AddApplicantForm({ postings, onAdded, onCancel }: { postings: { id: string; title: string }[]; onAdded: () => void; onCancel: () => void }) {
  const { t } = useI18n();
  const [postingId, setPostingId] = useState(postings[0]?.id ?? '');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await addApplicant(postingId, { firstName, lastName, email, phone: phone || undefined }, fileRef.current?.files?.[0]);
      onAdded();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('error.generic'));
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4" data-testid="add-applicant-form">
      <div>
        <Label htmlFor="aa-posting">{t('screening.posting')}</Label>
        <Select id="aa-posting" value={postingId} onChange={(e) => setPostingId(e.target.value)} required>
          {postings.map((p) => (
            <option key={p.id} value={p.id}>
              {p.title}
            </option>
          ))}
        </Select>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor="aa-first">{t('screening.firstName')}</Label>
          <Input id="aa-first" value={firstName} onChange={(e) => setFirstName(e.target.value)} required />
        </div>
        <div>
          <Label htmlFor="aa-last">{t('screening.lastName')}</Label>
          <Input id="aa-last" value={lastName} onChange={(e) => setLastName(e.target.value)} required />
        </div>
        <div>
          <Label htmlFor="aa-email">{t('screening.email')}</Label>
          <Input id="aa-email" type="email" dir="ltr" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </div>
        <div>
          <Label htmlFor="aa-phone">{t('screening.phone')}</Label>
          <Input id="aa-phone" dir="ltr" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </div>
      </div>
      <div>
        <Label htmlFor="aa-resume">{t('screening.resumeFile')}</Label>
        <input
          id="aa-resume"
          ref={fileRef}
          type="file"
          data-testid="add-applicant-file"
          accept=".pdf,.docx,.txt,application/pdf,text/plain,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          className="block w-full text-sm text-ink-600 file:me-3 file:rounded-lg file:border-0 file:bg-brand-50 file:px-3 file:py-2 file:text-sm file:font-semibold file:text-brand-700"
        />
      </div>
      {error && <Alert tone="error">{error}</Alert>}
      <div className="flex justify-end gap-2 border-t border-ink-100 pt-4">
        <Button type="button" variant="secondary" onClick={onCancel}>
          {t('action.cancel')}
        </Button>
        <Button type="submit" loading={saving} disabled={!postingId} data-testid="submit-add-applicant-button">
          {t('action.save')}
        </Button>
      </div>
    </form>
  );
}
