'use client';

import { FormEvent, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { useI18n } from '../../i18n/I18nProvider';
import { updateEmployee, UpdateEmployeeInput } from '../../lib/api/employees';
import { ApiError } from '../../lib/api/client';
import type { Employee } from '../../lib/api/types';
import { Button } from '../ui/Button';
import { Input, Label } from '../ui/Field';
import { Alert } from '../ui/Alert';

export function ProfileEditForm({ employee, onSaved, onCancel }: { employee: Employee; onSaved: () => void; onCancel: () => void }) {
  const { t } = useI18n();
  const [personalEmail, setPersonalEmail] = useState(employee.personalEmail ?? '');
  const [phone, setPhone] = useState(employee.phone ?? '');
  const [dateOfBirth, setDateOfBirth] = useState(employee.dateOfBirth ? employee.dateOfBirth.slice(0, 10) : '');
  const [gender, setGender] = useState(employee.gender ?? '');
  const [emergencyContacts, setEmergencyContacts] = useState(employee.emergencyContacts.map((c) => ({ ...c })));
  const [dependents, setDependents] = useState(employee.dependents.map((d) => ({ ...d, dateOfBirth: d.dateOfBirth ?? '' })));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const input: UpdateEmployeeInput = {
        personalEmail: personalEmail || undefined,
        phone: phone || undefined,
        dateOfBirth: dateOfBirth || undefined,
        gender: gender || undefined,
        emergencyContacts: emergencyContacts.map(({ name, relationship, phone: p }) => ({ name, relationship, phone: p })),
        dependents: dependents.map(({ name, relationship, dateOfBirth: dob }) => ({ name, relationship, dateOfBirth: dob || undefined })),
      };
      await updateEmployee(employee.id, input);
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('error.generic'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <Label htmlFor="personalEmail">{t('profile.personalEmail')}</Label>
          <Input id="personalEmail" type="email" value={personalEmail} onChange={(e) => setPersonalEmail(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="phone">{t('profile.phone')}</Label>
          <Input id="phone" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="dateOfBirth">{t('profile.dateOfBirth')}</Label>
          <Input id="dateOfBirth" type="date" value={dateOfBirth} onChange={(e) => setDateOfBirth(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="gender">{t('profile.gender')}</Label>
          <Input id="gender" value={gender} onChange={(e) => setGender(e.target.value)} />
        </div>
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <Label>{t('profile.emergencyContacts')}</Label>
          <button
            type="button"
            onClick={() => setEmergencyContacts((c) => [...c, { id: `new-${c.length}`, name: '', relationship: '', phone: '' }])}
            className="flex items-center gap-1 text-xs font-medium text-brand-700 hover:underline"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden />
            {t('profile.addEmergencyContact')}
          </button>
        </div>
        <div className="space-y-2">
          {emergencyContacts.map((c, i) => (
            <div key={c.id} className="flex items-center gap-2">
              <Input
                placeholder={t('common.name')}
                value={c.name}
                onChange={(e) => setEmergencyContacts((rows) => rows.map((r, idx) => (idx === i ? { ...r, name: e.target.value } : r)))}
              />
              <Input
                placeholder={t('common.relationship')}
                value={c.relationship}
                onChange={(e) => setEmergencyContacts((rows) => rows.map((r, idx) => (idx === i ? { ...r, relationship: e.target.value } : r)))}
              />
              <Input
                placeholder={t('common.phone')}
                value={c.phone}
                onChange={(e) => setEmergencyContacts((rows) => rows.map((r, idx) => (idx === i ? { ...r, phone: e.target.value } : r)))}
              />
              <button type="button" onClick={() => setEmergencyContacts((rows) => rows.filter((_, idx) => idx !== i))} className="shrink-0 p-1 text-ink-400 hover:text-coral-600">
                <Trash2 className="h-4 w-4" aria-hidden />
              </button>
            </div>
          ))}
        </div>
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <Label>{t('profile.dependents')}</Label>
          <button
            type="button"
            onClick={() => setDependents((d) => [...d, { id: `new-${d.length}`, name: '', relationship: '', dateOfBirth: '' }])}
            className="flex items-center gap-1 text-xs font-medium text-brand-700 hover:underline"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden />
            {t('profile.addDependent')}
          </button>
        </div>
        <div className="space-y-2">
          {dependents.map((d, i) => (
            <div key={d.id} className="flex items-center gap-2">
              <Input
                placeholder={t('common.name')}
                value={d.name}
                onChange={(e) => setDependents((rows) => rows.map((r, idx) => (idx === i ? { ...r, name: e.target.value } : r)))}
              />
              <Input
                placeholder={t('common.relationship')}
                value={d.relationship}
                onChange={(e) => setDependents((rows) => rows.map((r, idx) => (idx === i ? { ...r, relationship: e.target.value } : r)))}
              />
              <Input
                type="date"
                value={d.dateOfBirth}
                onChange={(e) => setDependents((rows) => rows.map((r, idx) => (idx === i ? { ...r, dateOfBirth: e.target.value } : r)))}
              />
              <button type="button" onClick={() => setDependents((rows) => rows.filter((_, idx) => idx !== i))} className="shrink-0 p-1 text-ink-400 hover:text-coral-600">
                <Trash2 className="h-4 w-4" aria-hidden />
              </button>
            </div>
          ))}
        </div>
      </div>

      {error && <Alert tone="error">{error}</Alert>}

      <div className="flex justify-end gap-2 border-t border-ink-100 pt-4">
        <Button type="button" variant="secondary" onClick={onCancel}>
          {t('action.cancel')}
        </Button>
        <Button type="submit" loading={saving}>
          {t('action.save')}
        </Button>
      </div>
    </form>
  );
}
