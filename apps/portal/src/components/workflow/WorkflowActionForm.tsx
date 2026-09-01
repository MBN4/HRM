'use client';

import { useState } from 'react';
import { Check, X } from 'lucide-react';
import { useI18n } from '../../i18n/I18nProvider';
import { actOnWorkflowStep } from '../../lib/api/workflow';
import { ApiError } from '../../lib/api/client';
import { Button } from '../ui/Button';
import { Textarea } from '../ui/Field';
import { Alert } from '../ui/Alert';

/**
 * The comment/approve/reject mini-form for one active workflow step —
 * extracted out of `ApprovalCard` (see docs/conventions/workflow.md) so
 * `WorkflowStatusPanel` can reuse it verbatim instead of duplicating the
 * `actOnWorkflowStep` call + busy/error state. `data-testid`s are kept
 * byte-identical to what `ApprovalCard` shipped with — `apps/portal/tests/
 * mss.spec.ts` (and others) already depend on `approve-button`/
 * `reject-button` scoped within their own card/panel.
 */
export function WorkflowActionForm({ instanceId, stepId, onActed }: { instanceId: string; stepId: string; onActed: () => void }) {
  const { t } = useI18n();
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState<'APPROVE' | 'REJECT' | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function act(actionType: 'APPROVE' | 'REJECT') {
    setBusy(actionType);
    setError(null);
    try {
      await actOnWorkflowStep(instanceId, stepId, { actionType, comment: comment || undefined });
      onActed();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('error.generic'));
      setBusy(null);
    }
  }

  return (
    <div className="space-y-3">
      <Textarea placeholder={t('approvals.commentPlaceholder')} rows={2} value={comment} onChange={(e) => setComment(e.target.value)} />

      {error && <Alert tone="error">{error}</Alert>}

      <div className="flex justify-end gap-2">
        <Button
          data-testid="reject-button"
          variant="danger"
          size="sm"
          loading={busy === 'REJECT'}
          disabled={busy !== null}
          onClick={() => act('REJECT')}
        >
          <X className="h-3.5 w-3.5" aria-hidden />
          {t('approvals.reject')}
        </Button>
        <Button data-testid="approve-button" size="sm" loading={busy === 'APPROVE'} disabled={busy !== null} onClick={() => act('APPROVE')}>
          <Check className="h-3.5 w-3.5" aria-hidden />
          {t('approvals.approve')}
        </Button>
      </div>
    </div>
  );
}
