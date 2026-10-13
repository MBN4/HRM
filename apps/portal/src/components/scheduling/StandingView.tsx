'use client';

import { useMemo, useState } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useI18n } from '../../i18n/I18nProvider';
import { useAsync } from '../../lib/useAsync';
import { ApiError } from '../../lib/api/client';
import { clearStanding, listShifts, listStanding, setStanding, type ShiftDefinition, type StandingRow } from '../../lib/api/scheduling';
import { Alert } from '../ui/Alert';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Card, CardBody, CardHeader, CardTitle } from '../ui/Card';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { Label } from '../ui/Field';
import { Modal } from '../ui/Modal';
import { Select } from '../ui/Select';
import { PageSpinner } from '../ui/Spinner';
import { useScheduling } from './SchedulingContext';
import { ShiftChip } from './ShiftChip';

type Scope = 'company' | 'teams' | 'members';
type Target = { scope: Scope; id: string | null; label: string; pick?: boolean };

function StandingCell({ row }: { row: StandingRow | undefined }) {
  const { t } = useI18n();
  if (!row) return <span className="text-ink-400">{t('scheduling.standing.none')}</span>;
  if (row.kind === 'SHIFT' && row.shift) return <ShiftChip name={row.shift.name} color={row.shift.color} startTime={row.shift.startTime} endTime={row.shift.endTime} />;
  return <Badge tone="neutral">{t('scheduling.standing.custom')}</Badge>;
}

function StandingModal({
  target,
  shifts,
  people,
  takenMembers,
  onClose,
  onSaved,
}: {
  target: Target;
  shifts: ShiftDefinition[];
  people: { id: string; name: string; code: string }[];
  takenMembers: Set<string>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const [shiftId, setShiftId] = useState('');
  const [memberId, setMemberId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function save() {
    const id = target.pick ? memberId : target.id;
    if (!shiftId || (target.scope !== 'company' && !id)) {
      setError(t('scheduling.standing.err.pick'));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await setStanding(target.scope, target.scope === 'company' ? null : id, shiftId);
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('error.generic'));
      setSaving(false);
    }
  }

  return (
    <Modal title={t('scheduling.standing.setTitle', { name: target.pick ? t('scheduling.standing.member') : target.label })} onClose={onClose}>
      <div className="space-y-4" data-testid="standing-modal">
        <p className="text-sm text-ink-600">{t('scheduling.standing.setHint')}</p>
        {target.pick && (
          <div>
            <Label htmlFor="standing-member">{t('scheduling.standing.member')}</Label>
            <Select id="standing-member" searchable value={memberId} onChange={(e) => setMemberId(e.target.value)} data-testid="standing-member">
              <option value="">{t('scheduling.standing.pickMember')}</option>
              {people.map((p) => (
                <option key={p.id} value={p.id} disabled={takenMembers.has(p.id)}>
                  {p.name} ({p.code})
                </option>
              ))}
            </Select>
          </div>
        )}
        <div>
          <Label htmlFor="standing-shift">{t('scheduling.standing.shift')}</Label>
          <Select id="standing-shift" searchable={false} value={shiftId} onChange={(e) => setShiftId(e.target.value)} data-testid="standing-shift">
            <option value="">{t('scheduling.standing.pickShift')}</option>
            {shifts.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.startTime}–{s.endTime})
              </option>
            ))}
          </Select>
        </div>
        {error && <Alert tone="error" data-testid="standing-error">{error}</Alert>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            {t('action.cancel')}
          </Button>
          <Button onClick={save} loading={saving} data-testid="standing-save">
            {t('action.save')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * Standing assignment (company / team / member). A standing shift is stored as a working-hours policy row linked to a
 * shift; precedence member > team > company > Country Pack. Managers may only manage members in their reporting chain
 * (the API enforces it; the company/team cards are simply not offered).
 */
export function StandingView() {
  const { t } = useI18n();
  const { people } = useScheduling();
  const tenantWide = !!people?.tenantWide;
  const { data: rows, loading, error, reload } = useAsync(() => listStanding(), []);
  const { data: shifts } = useAsync(() => listShifts(), []);
  const [dialog, setDialog] = useState<Target | null>(null);
  const [removing, setRemoving] = useState<{ scope: Scope; id: string | null; label: string } | null>(null);

  const company = rows?.find((r) => r.scope === 'COMPANY');
  const teamRow = useMemo(() => new Map((rows ?? []).filter((r) => r.scope === 'TEAM').map((r) => [r.target?.id ?? '', r])), [rows]);
  const memberRows = (rows ?? []).filter((r) => r.scope === 'MEMBER');
  const takenMembers = useMemo(() => new Set(memberRows.map((r) => r.target?.id ?? '')), [memberRows]);

  const actions = (scope: Scope, id: string | null, label: string, row: StandingRow | undefined, testKey: string) => (
    <div className="flex justify-end gap-1">
      <Button variant="ghost" size="sm" aria-label={`${row ? t('action.edit') : t('scheduling.standing.set')}: ${label}`} onClick={() => setDialog({ scope, id, label })} data-testid={`standing-set-${testKey}`}>
        {row ? <Pencil className="h-4 w-4" aria-hidden /> : <Plus className="h-4 w-4" aria-hidden />}
      </Button>
      {row?.kind === 'SHIFT' && (
        <Button variant="ghost" size="sm" aria-label={`${t('scheduling.standing.clear')}: ${label}`} onClick={() => setRemoving({ scope, id, label })} data-testid={`standing-clear-${testKey}`}>
          <Trash2 className="h-4 w-4" aria-hidden />
        </Button>
      )}
    </div>
  );

  return (
    <div className="space-y-6">
      <p className="text-sm text-ink-500">{t('scheduling.standing.hint')}</p>
      {error && <Alert tone="error">{error}</Alert>}
      {!tenantWide && people && <Alert tone="info">{t('scheduling.standing.managerNote')}</Alert>}
      {loading && !rows ? (
        <PageSpinner />
      ) : (
        <>
          {tenantWide && (
            <Card>
              <CardHeader>
                <CardTitle>{t('scheduling.standing.company')}</CardTitle>
                {actions('company', null, t('scheduling.standing.company'), company, 'company')}
              </CardHeader>
              <CardBody className="flex items-center gap-3 text-sm">
                <StandingCell row={company} />
                {!company && <span className="text-ink-500">{t('scheduling.standing.companyNone')}</span>}
              </CardBody>
            </Card>
          )}

          {tenantWide && (
            <Card>
              <CardHeader>
                <CardTitle>{t('scheduling.standing.teams')}</CardTitle>
              </CardHeader>
              <CardBody className="px-0 py-0">
                <table className="w-full text-sm" data-testid="standing-teams">
                  <caption className="sr-only">{t('scheduling.standing.teams')}</caption>
                  <thead>
                    <tr className="border-b border-ink-100 text-xs text-ink-500">
                      <th scope="col" className="px-5 py-2.5 text-start font-medium">{t('scheduling.standing.team')}</th>
                      <th scope="col" className="px-3 py-2.5 text-start font-medium">{t('scheduling.standing.shift')}</th>
                      <th scope="col" className="px-5 py-2.5 text-end"><span className="sr-only">{t('workingHours.table.actions')}</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {(people?.departments ?? []).map((d) => {
                      const row = teamRow.get(d.id);
                      return (
                        <tr key={d.id} className="border-b border-ink-100 last:border-0" data-testid={`standing-team-row-${d.name}`}>
                          <td className="px-5 py-3 font-medium text-ink-900">
                            {d.name} <span className="font-normal text-ink-400">· {d.branchName}</span>
                          </td>
                          <td className="px-3 py-3"><StandingCell row={row} /></td>
                          <td className="px-5 py-3">{actions('teams', d.id, d.name, row, `team-${d.name}`)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </CardBody>
            </Card>
          )}

          <Card>
            <CardHeader className="flex-wrap">
              <CardTitle>{t('scheduling.standing.members')}</CardTitle>
              <Button size="sm" onClick={() => setDialog({ scope: 'members', id: null, label: '', pick: true })} data-testid="standing-add-member">
                <Plus className="h-4 w-4" aria-hidden />
                {t('scheduling.standing.addMember')}
              </Button>
            </CardHeader>
            <CardBody className="px-0 py-0">
              {memberRows.length === 0 ? (
                <p className="px-5 py-6 text-sm text-ink-500">{t('scheduling.standing.membersEmpty')}</p>
              ) : (
                <table className="w-full text-sm" data-testid="standing-members">
                  <caption className="sr-only">{t('scheduling.standing.members')}</caption>
                  <thead>
                    <tr className="border-b border-ink-100 text-xs text-ink-500">
                      <th scope="col" className="px-5 py-2.5 text-start font-medium">{t('scheduling.standing.member')}</th>
                      <th scope="col" className="px-3 py-2.5 text-start font-medium">{t('scheduling.standing.shift')}</th>
                      <th scope="col" className="px-5 py-2.5 text-end"><span className="sr-only">{t('workingHours.table.actions')}</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {memberRows.map((r) => (
                      <tr key={r.id} className="border-b border-ink-100 last:border-0" data-testid={`standing-member-row-${r.target?.code ?? r.target?.label}`}>
                        <td className="px-5 py-3 font-medium text-ink-900">
                          {r.target?.label}
                          {r.target?.code && <span className="ms-1 font-normal text-ink-400">({r.target.code})</span>}
                        </td>
                        <td className="px-3 py-3"><StandingCell row={r} /></td>
                        <td className="px-5 py-3">{actions('members', r.target?.id ?? null, r.target?.label ?? '', r, `member-${r.target?.code ?? r.target?.label}`)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </CardBody>
          </Card>
        </>
      )}

      {dialog && (
        <StandingModal
          target={dialog}
          shifts={shifts ?? []}
          people={people?.employees ?? []}
          takenMembers={takenMembers}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            reload();
          }}
        />
      )}
      {removing && (
        <ConfirmDialog
          title={t('scheduling.standing.clearTitle', { name: removing.label })}
          body={t('scheduling.standing.clearBody')}
          confirmLabel={t('scheduling.standing.clear')}
          tone="danger"
          onClose={() => setRemoving(null)}
          onConfirm={async () => {
            await clearStanding(removing.scope, removing.id);
            setRemoving(null);
            reload();
          }}
        />
      )}
    </div>
  );
}
