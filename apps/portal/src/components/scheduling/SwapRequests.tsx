'use client';

import Link from 'next/link';
import { useState } from 'react';
import { PERMISSIONS } from '@hrm/shared';
import { useI18n } from '../../i18n/I18nProvider';
import { useAuth } from '../../lib/auth/AuthContext';
import { useAsync } from '../../lib/useAsync';
import { ApiError } from '../../lib/api/client';
import { cancelSwap, listSwaps, respondSwap, type ShiftSwap, type SwapStatus } from '../../lib/api/scheduling';
import { formatDayLong } from '../../lib/scheduling';
import { Alert } from '../ui/Alert';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Card, CardBody, CardHeader, CardTitle } from '../ui/Card';
import { PageSpinner } from '../ui/Spinner';

const TONE: Record<SwapStatus, 'neutral' | 'success' | 'warning' | 'danger' | 'info'> = {
  AWAITING_PEER: 'warning',
  PENDING_APPROVAL: 'info',
  APPROVED: 'success',
  REJECTED: 'danger',
  DECLINED: 'danger',
  CANCELED: 'neutral',
};

function SwapList({
  swaps,
  myEmployeeId,
  locale,
  onChanged,
  setError,
  readOnly,
  testPrefix,
}: {
  swaps: ShiftSwap[];
  myEmployeeId: string | null;
  locale: string;
  onChanged: () => void;
  setError: (m: string | null) => void;
  readOnly?: boolean;
  testPrefix: string;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState<string | null>(null);

  async function act(id: string, fn: () => Promise<unknown>) {
    setBusy(id);
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('error.generic'));
    } finally {
      setBusy(null);
    }
  }

  if (swaps.length === 0) return <p className="px-5 py-6 text-sm text-ink-500">{t('schedule.swap.empty')}</p>;
  return (
    <ul className="divide-y divide-ink-100" data-testid={`${testPrefix}-list`}>
      {swaps.map((s) => {
        const iAmRequester = s.requester?.id === myEmployeeId;
        const iAmCounterpart = s.counterpart?.id === myEmployeeId;
        const open = s.status === 'AWAITING_PEER' || s.status === 'PENDING_APPROVAL';
        return (
          <li key={s.id} className="space-y-2 px-5 py-3" data-testid={`swap-${s.id}`} data-status={s.status}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-semibold text-ink-900">
                {t('schedule.swap.line', { requester: s.requester?.name ?? '—', counterpart: s.counterpart?.name ?? '—' })}
              </p>
              <Badge tone={TONE[s.status]}>
                <span data-testid={`swap-status-${s.id}`}>{t(`schedule.swap.status.${s.status}`)}</span>
              </Badge>
            </div>
            <p className="text-xs text-ink-600">
              {formatDayLong(s.date, locale)}
              {s.requesterShift && <> · {s.requesterShift.name} <bdi dir="ltr">{s.requesterShift.startTime}–{s.requesterShift.endTime}</bdi></>}
              {s.counterpartShift && <> ⇄ {s.counterpartShift.name} <bdi dir="ltr">{s.counterpartShift.startTime}–{s.counterpartShift.endTime}</bdi></>}
            </p>
            {s.reason && <p className="text-xs italic text-ink-500">“{s.reason}”</p>}
            <p className="text-xs text-ink-500">{t(`schedule.swap.hint.${s.status}`)}</p>
            {s.status === 'PENDING_APPROVAL' && (
              <Link href="/approvals" className="text-xs font-semibold text-brand-700 hover:underline">
                {t('schedule.swap.approvalsLink')}
              </Link>
            )}
            {!readOnly && (
              <div className="flex flex-wrap gap-2">
                {iAmCounterpart && s.status === 'AWAITING_PEER' && (
                  <>
                    <Button size="sm" loading={busy === s.id} onClick={() => act(s.id, () => respondSwap(s.id, true))} data-testid={`swap-accept-${s.id}`}>
                      {t('schedule.swap.accept')}
                    </Button>
                    <Button size="sm" variant="secondary" disabled={busy === s.id} onClick={() => act(s.id, () => respondSwap(s.id, false))} data-testid={`swap-decline-${s.id}`}>
                      {t('schedule.swap.decline')}
                    </Button>
                  </>
                )}
                {iAmRequester && open && (
                  <Button size="sm" variant="ghost" loading={busy === s.id} onClick={() => act(s.id, () => cancelSwap(s.id))} data-testid={`swap-cancel-${s.id}`}>
                    {t('schedule.swap.cancel')}
                  </Button>
                )}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** "Swap requests" (mine) and, for managers, "Team swap requests". Approval itself is the generic workflow engine — see /approvals. */
export function SwapRequests({ myEmployeeId, version, onChanged }: { myEmployeeId: string; version: number; onChanged: () => void }) {
  const { t, locale } = useI18n();
  const { can } = useAuth();
  const isManager = can(PERMISSIONS.SCHEDULING_MANAGE);
  const [error, setError] = useState<string | null>(null);
  const mine = useAsync(() => listSwaps('mine'), [version]);
  const team = useAsync(() => (isManager ? listSwaps('team') : Promise.resolve([] as ShiftSwap[])), [version, isManager]);

  return (
    <div className="space-y-6">
      {error && <Alert tone="error" data-testid="swap-list-error">{error}</Alert>}
      <Card data-testid="swap-requests">
        <CardHeader>
          <CardTitle>{t('schedule.swap.mine')}</CardTitle>
        </CardHeader>
        <CardBody className="px-0 py-0">
          {mine.loading && !mine.data ? <PageSpinner /> : <SwapList swaps={mine.data ?? []} myEmployeeId={myEmployeeId} locale={locale} onChanged={onChanged} setError={setError} testPrefix="swaps-mine" />}
        </CardBody>
      </Card>
      {isManager && (
        <Card data-testid="team-swap-requests">
          <CardHeader>
            <CardTitle>{t('schedule.swap.team')}</CardTitle>
          </CardHeader>
          <CardBody className="px-0 py-0">
            {team.loading && !team.data ? <PageSpinner /> : <SwapList swaps={team.data ?? []} myEmployeeId={myEmployeeId} locale={locale} onChanged={onChanged} setError={setError} readOnly testPrefix="swaps-team" />}
          </CardBody>
        </Card>
      )}
    </div>
  );
}
