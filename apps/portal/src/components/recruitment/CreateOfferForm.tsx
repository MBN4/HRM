'use client';

import { FormEvent, useState } from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import { useAsync } from '../../lib/useAsync';
import { useSession } from '../../lib/session/SessionProvider';
import { createOffer, listApplications } from '../../lib/api/recruitment';
import { listBranches } from '../../lib/api/tenancy';
import { ApiError } from '../../lib/api/client';
import { Button } from '../ui/Button';
import { Input, Label, Select } from '../ui/Field';
import { Alert } from '../ui/Alert';
import type { Offer, RecruitmentEmploymentType } from '../../lib/api/types';

const EMPLOYMENT_TYPES: RecruitmentEmploymentType[] = ['FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERN'];

/** `applicationId` is populated from applications already at the `OFFER` stage — offers only make sense that far along the pipeline. */
export function CreateOfferForm({ onCreated, onCancel }: { onCreated: (offer: Offer) => void; onCancel: () => void }) {
  const { t } = useI18n();
  const { pack } = useSession();
  const { data: offerStageApplications } = useAsync(() => listApplications({ stage: 'OFFER' }), []);
  const { data: branches } = useAsync(() => listBranches(), []);

  const [applicationId, setApplicationId] = useState('');
  const [branchId, setBranchId] = useState('');
  const [employmentType, setEmploymentType] = useState<RecruitmentEmploymentType>('FULL_TIME');
  const [proposedSalary, setProposedSalary] = useState(0);
  const [salaryCurrency, setSalaryCurrency] = useState(pack?.locale.currencyCode ?? 'USD');
  const [proposedJoinDate, setProposedJoinDate] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!applicationId || !branchId) return;
    setSubmitting(true);
    setError(null);
    try {
      const offer = await createOffer({
        applicationId,
        branchId,
        employmentType,
        proposedSalary,
        salaryCurrency: salaryCurrency.toUpperCase(),
        proposedJoinDate,
      });
      onCreated(offer);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('error.generic'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <Label htmlFor="offer-application">{t('recruitment.candidates')}</Label>
        <Select id="offer-application" value={applicationId} onChange={(e) => setApplicationId(e.target.value)} required>
          <option value="" disabled>
            {t('recruitment.candidates')}
          </option>
          {(offerStageApplications ?? []).map((a) => (
            <option key={a.id} value={a.id}>
              {a.id.slice(0, 8)}…
            </option>
          ))}
        </Select>
      </div>
      <div>
        <Label htmlFor="offer-branch">{t('common.branch')}</Label>
        <Select id="offer-branch" value={branchId} onChange={(e) => setBranchId(e.target.value)} required>
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
          <Label htmlFor="offer-employment-type">{t('recruitment.employmentType')}</Label>
          <Select id="offer-employment-type" value={employmentType} onChange={(e) => setEmploymentType(e.target.value as RecruitmentEmploymentType)}>
            {EMPLOYMENT_TYPES.map((et) => (
              <option key={et} value={et}>
                {t(`analytics.employmentType.${et}`)}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label htmlFor="offer-join-date">{t('recruitment.proposedJoinDate')}</Label>
          <Input id="offer-join-date" type="date" value={proposedJoinDate} onChange={(e) => setProposedJoinDate(e.target.value)} required />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <Label htmlFor="offer-salary">{t('recruitment.proposedSalary')}</Label>
          <Input
            id="offer-salary"
            type="number"
            min={0}
            value={proposedSalary}
            onChange={(e) => setProposedSalary(Number(e.target.value))}
            required
          />
        </div>
        <div>
          <Label htmlFor="offer-currency">{t('recruitment.salaryCurrency')}</Label>
          <Input id="offer-currency" maxLength={3} value={salaryCurrency} onChange={(e) => setSalaryCurrency(e.target.value)} required />
        </div>
      </div>

      {error && <Alert tone="error">{error}</Alert>}

      <div className="flex justify-end gap-2 border-t border-ink-100 pt-4">
        <Button type="button" variant="secondary" onClick={onCancel}>
          {t('action.cancel')}
        </Button>
        <Button type="submit" loading={submitting} disabled={!applicationId || !branchId} data-testid="submit-new-offer-button">
          {t('action.save')}
        </Button>
      </div>
    </form>
  );
}
