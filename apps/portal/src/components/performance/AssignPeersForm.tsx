'use client';

import { FormEvent, useState } from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import { useAsync } from '../../lib/useAsync';
import { listEmployees } from '../../lib/api/employees';
import { assignPeerReviewers } from '../../lib/api/performance';
import { ApiError } from '../../lib/api/client';
import { Button } from '../ui/Button';
import { Alert } from '../ui/Alert';
import { PageSpinner } from '../ui/Spinner';
import type { ReviewAssignment } from '../../lib/api/types';

/**
 * A simple employee multiselect (no dedicated `EmployeePicker` abstraction —
 * this is the only place in this stage's scope that needs one) sourced from
 * `listEmployees()`. Peer reviewers are picked at the Employee level, same
 * as `POST /performance/appraisals/:id/peer-assignments` expects (see
 * docs/conventions/performance.md — `ReviewAssignment.reviewerId` is an
 * Employee id, resolved to a linked User only at review-submission time).
 */
export function AssignPeersForm({ appraisalId, onAssigned, onCancel }: { appraisalId: string; onAssigned: (rows: ReviewAssignment[]) => void; onCancel: () => void }) {
  const { t } = useI18n();
  const { data: employeeResult, loading } = useAsync(() => listEmployees({ pageSize: 200 }), []);
  const [selected, setSelected] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggle(employeeId: string) {
    setSelected((current) => (current.includes(employeeId) ? current.filter((x) => x !== employeeId) : [...current, employeeId]));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (selected.length === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      const rows = await assignPeerReviewers(appraisalId, { reviewerIds: selected });
      onAssigned(rows);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('error.generic'));
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) return <PageSpinner />;

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="max-h-72 space-y-1.5 overflow-y-auto">
        {(employeeResult?.data ?? []).map((employee) => (
          <label key={employee.id} className="flex items-center gap-2 text-sm text-ink-700">
            <input
              type="checkbox"
              data-testid="peer-candidate-checkbox"
              checked={selected.includes(employee.id)}
              onChange={() => toggle(employee.id)}
              className="h-4 w-4 rounded border-ink-300 text-brand-600"
            />
            {employee.firstName} {employee.lastName} ({employee.employeeCode})
          </label>
        ))}
      </div>

      {error && <Alert tone="error">{error}</Alert>}

      <div className="flex justify-end gap-2 border-t border-ink-100 pt-4">
        <Button type="button" variant="secondary" onClick={onCancel}>
          {t('action.cancel')}
        </Button>
        <Button type="submit" loading={submitting} disabled={selected.length === 0} data-testid="submit-peers-button">
          {t('performance.assignPeers')}
        </Button>
      </div>
    </form>
  );
}
