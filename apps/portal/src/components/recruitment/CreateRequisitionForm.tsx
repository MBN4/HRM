'use client';

import { FormEvent, useState } from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import { useAsync } from '../../lib/useAsync';
import { createJobRequisition } from '../../lib/api/recruitment';
import { listBranches } from '../../lib/api/tenancy';
import { ApiError } from '../../lib/api/client';
import { Button } from '../ui/Button';
import { Input, Label, Select, Textarea } from '../ui/Field';
import { Alert } from '../ui/Alert';
import type { JobRequisition, RecruitmentEmploymentType } from '../../lib/api/types';

const EMPLOYMENT_TYPES: RecruitmentEmploymentType[] = ['FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERN'];

/**
 * No department/designation pickers — a deliberate, documented limitation
 * (no `GET /departments`/`GET /designations` endpoint exists anywhere in
 * this codebase; both fields are optional on `createJobRequisitionSchema`).
 */
export function CreateRequisitionForm({ onCreated, onCancel }: { onCreated: (requisition: JobRequisition) => void; onCancel: () => void }) {
  const { t } = useI18n();
  const { data: branches } = useAsync(() => listBranches(), []);
  const [title, setTitle] = useState('');
  const [branchId, setBranchId] = useState('');
  const [employmentType, setEmploymentType] = useState<RecruitmentEmploymentType>('FULL_TIME');
  const [headcount, setHeadcount] = useState(1);
  const [justification, setJustification] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!branchId) return;
    setSubmitting(true);
    setError(null);
    try {
      const requisition = await createJobRequisition({
        title,
        branchId,
        employmentType,
        headcount,
        justification: justification || undefined,
      });
      onCreated(requisition);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('error.generic'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <Label htmlFor="requisition-title">{t('recruitment.title')}</Label>
        <Input id="requisition-title" value={title} onChange={(e) => setTitle(e.target.value)} required />
      </div>
      <div>
        <Label htmlFor="requisition-branch">{t('common.branch')}</Label>
        <Select id="requisition-branch" value={branchId} onChange={(e) => setBranchId(e.target.value)} required>
          <option value="" disabled>
            {t('common.branch')}
          </option>
          {(branches ?? []).map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </Select>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <Label htmlFor="requisition-employment-type">{t('recruitment.employmentType')}</Label>
          <Select id="requisition-employment-type" value={employmentType} onChange={(e) => setEmploymentType(e.target.value as RecruitmentEmploymentType)}>
            {EMPLOYMENT_TYPES.map((et) => (
              <option key={et} value={et}>
                {t(`analytics.employmentType.${et}`)}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label htmlFor="requisition-headcount">{t('recruitment.headcount')}</Label>
          <Input
            id="requisition-headcount"
            type="number"
            min={1}
            value={headcount}
            onChange={(e) => setHeadcount(Number(e.target.value))}
            required
          />
        </div>
      </div>
      <div>
        <Label htmlFor="requisition-justification">
          {t('recruitment.justification')} <span className="text-ink-400">({t('common.optional')})</span>
        </Label>
        <Textarea id="requisition-justification" rows={3} value={justification} onChange={(e) => setJustification(e.target.value)} />
      </div>

      {error && <Alert tone="error">{error}</Alert>}

      <div className="flex justify-end gap-2 border-t border-ink-100 pt-4">
        <Button type="button" variant="secondary" onClick={onCancel}>
          {t('action.cancel')}
        </Button>
        <Button type="submit" loading={submitting} data-testid="submit-new-requisition-button">
          {t('action.save')}
        </Button>
      </div>
    </form>
  );
}
