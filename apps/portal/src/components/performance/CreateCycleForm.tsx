'use client';

import { FormEvent, useState } from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import { useAsync } from '../../lib/useAsync';
import { createAppraisalCycle, listRatingScales } from '../../lib/api/performance';
import { listBranches } from '../../lib/api/tenancy';
import { ApiError } from '../../lib/api/client';
import { Button } from '../ui/Button';
import { Input, Label, Select } from '../ui/Field';
import { Alert } from '../ui/Alert';
import { Modal } from '../ui/Modal';
import { RatingScaleForm } from './RatingScaleForm';
import type { AppraisalCycle, AppraisalCycleType, ReviewType } from '../../lib/api/types';

const CYCLE_TYPES: AppraisalCycleType[] = ['ANNUAL', 'QUARTERLY', 'PROBATION'];
const REVIEW_TYPES: ReviewType[] = ['SELF', 'MANAGER', 'PEER', 'UPWARD'];

export function CreateCycleForm({ onCreated, onCancel }: { onCreated: (cycle: AppraisalCycle) => void; onCancel: () => void }) {
  const { t } = useI18n();
  const { data: ratingScales, reload: reloadScales } = useAsync(() => listRatingScales(), []);
  const { data: branches } = useAsync(() => listBranches(), []);

  const [name, setName] = useState('');
  const [cycleType, setCycleType] = useState<AppraisalCycleType>('ANNUAL');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [ratingScaleKey, setRatingScaleKey] = useState('');
  const [enabledReviewTypes, setEnabledReviewTypes] = useState<ReviewType[]>(['SELF', 'MANAGER']);
  const [eligibleBranchIds, setEligibleBranchIds] = useState<string[]>([]);
  const [managingScales, setManagingScales] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggleReviewType(rt: ReviewType) {
    setEnabledReviewTypes((current) => (current.includes(rt) ? current.filter((x) => x !== rt) : [...current, rt]));
  }

  function toggleBranch(branchId: string) {
    setEligibleBranchIds((current) => (current.includes(branchId) ? current.filter((x) => x !== branchId) : [...current, branchId]));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!ratingScaleKey || enabledReviewTypes.length === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      const cycle = await createAppraisalCycle({
        name,
        cycleType,
        startDate,
        endDate,
        ratingScaleKey,
        enabledReviewTypes,
        eligibleBranchIds,
        eligibleDepartmentIds: [],
      });
      onCreated(cycle);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('error.generic'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <Label htmlFor="cycle-name">{t('performance.cycleName')}</Label>
          <Input id="cycle-name" value={name} onChange={(e) => setName(e.target.value)} required />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label htmlFor="cycle-type">{t('performance.cycleType')}</Label>
            <Select id="cycle-type" value={cycleType} onChange={(e) => setCycleType(e.target.value as AppraisalCycleType)}>
              {CYCLE_TYPES.map((ct) => (
                <option key={ct} value={ct}>
                  {t(`performance.cycleType.${ct}`)}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="cycle-rating-scale">{t('performance.ratingScale')}</Label>
            <Select id="cycle-rating-scale" value={ratingScaleKey} onChange={(e) => setRatingScaleKey(e.target.value)} required>
              <option value="" disabled>
                {t('performance.ratingScale')}
              </option>
              {(ratingScales ?? []).map((rs) => (
                <option key={rs.key} value={rs.key}>
                  {rs.name}
                </option>
              ))}
            </Select>
          </div>
        </div>

        {(ratingScales ?? []).length === 0 && <Alert tone="info">{t('performance.noRatingScales')}</Alert>}
        <button
          type="button"
          data-testid="manage-rating-scales-link"
          onClick={() => setManagingScales(true)}
          className="text-sm font-medium text-brand-700 hover:underline"
        >
          {t('performance.manageRatingScales')}
        </button>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label htmlFor="cycle-start-date">{t('performance.startDate')}</Label>
            <Input id="cycle-start-date" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} required />
          </div>
          <div>
            <Label htmlFor="cycle-end-date">{t('performance.endDate')}</Label>
            <Input id="cycle-end-date" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} required />
          </div>
        </div>

        <div>
          <Label>{t('performance.enabledReviewTypes')}</Label>
          <div className="flex flex-wrap gap-3">
            {REVIEW_TYPES.map((rt) => (
              <label key={rt} className="flex items-center gap-1.5 text-sm text-ink-700">
                <input
                  type="checkbox"
                  data-testid={`review-type-${rt}`}
                  checked={enabledReviewTypes.includes(rt)}
                  onChange={() => toggleReviewType(rt)}
                  className="h-4 w-4 rounded border-ink-300 text-brand-600"
                />
                {t(`performance.reviewType.${rt}`)}
              </label>
            ))}
          </div>
        </div>

        <div>
          <Label>{t('performance.eligibleBranches')}</Label>
          <div className="flex flex-wrap gap-3">
            {(branches ?? []).map((b) => (
              <label key={b.id} className="flex items-center gap-1.5 text-sm text-ink-700">
                <input
                  type="checkbox"
                  data-testid={`eligible-branch-${b.id}`}
                  checked={eligibleBranchIds.includes(b.id)}
                  onChange={() => toggleBranch(b.id)}
                  className="h-4 w-4 rounded border-ink-300 text-brand-600"
                />
                {b.name}
              </label>
            ))}
          </div>
        </div>

        {error && <Alert tone="error">{error}</Alert>}

        <div className="flex justify-end gap-2 border-t border-ink-100 pt-4">
          <Button type="button" variant="secondary" onClick={onCancel}>
            {t('action.cancel')}
          </Button>
          <Button type="submit" loading={submitting} data-testid="submit-new-cycle-button">
            {t('action.save')}
          </Button>
        </div>
      </form>

      {managingScales && (
        <Modal title={t('performance.newRatingScale')} onClose={() => setManagingScales(false)}>
          <RatingScaleForm
            onCancel={() => setManagingScales(false)}
            onCreated={(scale) => {
              setManagingScales(false);
              reloadScales();
              setRatingScaleKey(scale.key);
            }}
          />
        </Modal>
      )}
    </>
  );
}
