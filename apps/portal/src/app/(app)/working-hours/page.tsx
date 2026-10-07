'use client';

import { useMemo, useState } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { PERMISSIONS } from '@hrm/shared';
import { useI18n } from '../../../i18n/I18nProvider';
import { useAuth } from '../../../lib/auth/AuthContext';
import { useAsync } from '../../../lib/useAsync';
import {
  deleteMemberPolicy,
  deleteTeamPolicy,
  getWorkingHoursTargets,
  listWorkingHoursPolicies,
  saveCompanyPolicy,
  type WorkingHoursPolicy,
} from '../../../lib/api/working-hours';
import { Alert } from '../../../components/ui/Alert';
import { Button } from '../../../components/ui/Button';
import { Card, CardBody, CardHeader, CardTitle } from '../../../components/ui/Card';
import { ConfirmDialog } from '../../../components/ui/ConfirmDialog';
import { EmptyState } from '../../../components/ui/EmptyState';
import { PageSpinner } from '../../../components/ui/Spinner';
import { EffectivePolicyCard } from '../../../components/working-hours/EffectivePolicyCard';
import { OverrideModal } from '../../../components/working-hours/OverrideModal';
import { PolicyForm, valuesFromPolicy, DEFAULT_FORM } from '../../../components/working-hours/PolicyForm';

type Dialog =
  | { kind: 'add'; scope: 'TEAM' | 'MEMBER' }
  | { kind: 'edit'; policy: WorkingHoursPolicy }
  | { kind: 'remove'; policy: WorkingHoursPolicy };

/**
 * Working hours (step 8.1) — company default, team overrides, member
 * overrides, and the "effective policy" precedence demo
 * (Member -> Team -> Company -> Country Pack). Gated on
 * `working_hours.manage`; the API enforces regardless.
 */
export default function WorkingHoursPage() {
  const { t } = useI18n();
  const { can } = useAuth();
  const canManage = can(PERMISSIONS.WORKING_HOURS_MANAGE);

  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [version, setVersion] = useState(0);

  const { data: policies, loading, error, reload } = useAsync(() => (canManage ? listWorkingHoursPolicies() : Promise.resolve(null)), [canManage]);
  const { data: targets } = useAsync(() => (canManage ? getWorkingHoursTargets() : Promise.resolve(null)), [canManage]);

  const company = useMemo(() => policies?.find((p) => p.scope === 'COMPANY') ?? null, [policies]);
  const teams = useMemo(() => (policies ?? []).filter((p) => p.scope === 'TEAM'), [policies]);
  const members = useMemo(() => (policies ?? []).filter((p) => p.scope === 'MEMBER'), [policies]);

  if (!canManage) {
    return <Alert tone="info">{t('workingHours.noAccess')}</Alert>;
  }

  function changed() {
    setDialog(null);
    setVersion((v) => v + 1);
    reload();
  }

  const taken = (scope: 'TEAM' | 'MEMBER') => new Set((scope === 'TEAM' ? teams : members).map((p) => p.target?.id ?? ''));

  const summary = (p: WorkingHoursPolicy) => ({
    workBreak: `${p.workHours} + ${p.breakHours} h`,
    half: p.halfDayThresholdHours === null ? t('workingHours.table.halfDerived', { value: String(Math.round((p.requiredHours / 2) * 100) / 100) }) : `${p.halfDayThresholdHours} h`,
  });

  function overrideTable(scope: 'TEAM' | 'MEMBER', rows: WorkingHoursPolicy[]) {
    const isTeam = scope === 'TEAM';
    if (rows.length === 0) {
      return <EmptyState title={t(isTeam ? 'workingHours.team.empty' : 'workingHours.member.empty')} description={t('workingHours.empty.hint')} />;
    }
    return (
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <caption className="sr-only">{t(isTeam ? 'workingHours.team.title' : 'workingHours.member.title')}</caption>
          <thead>
            <tr className="border-b border-ink-100 text-start text-xs text-ink-500">
              <th scope="col" className="px-5 py-2.5 text-start font-medium">{t(isTeam ? 'workingHours.team.label' : 'workingHours.member.label')}</th>
              <th scope="col" className="px-3 py-2.5 text-start font-medium">{t('workingHours.field.startTime')}</th>
              <th scope="col" className="px-3 py-2.5 text-start font-medium">{t('workingHours.table.workBreak')}</th>
              <th scope="col" className="px-3 py-2.5 text-start font-medium">{t('workingHours.field.grace')}</th>
              <th scope="col" className="px-3 py-2.5 text-start font-medium">{t('workingHours.field.halfDay')}</th>
              <th scope="col" className="px-5 py-2.5 text-end font-medium">
                <span className="sr-only">{t('workingHours.table.actions')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => {
              const s = summary(p);
              const label = p.target?.label ?? '';
              const rowKey = isTeam ? label : (p.target?.code ?? label);
              return (
                <tr key={p.id} className="border-b border-ink-100 last:border-0" data-testid={`wh-${isTeam ? 'team' : 'member'}-row-${rowKey}`}>
                  <td className="px-5 py-3 font-medium text-ink-900">
                    {label}
                    {!isTeam && p.target?.code ? <span className="ms-1 text-ink-500">({p.target.code})</span> : null}
                  </td>
                  <td className="px-3 py-3 text-ink-700">{p.startTime}</td>
                  <td className="px-3 py-3 text-ink-700">{s.workBreak}</td>
                  <td className="px-3 py-3 text-ink-700">{p.graceMinutes} min</td>
                  <td className="px-3 py-3 text-ink-700">{s.half}</td>
                  <td className="px-5 py-3">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="sm" aria-label={`${t('action.edit')}: ${label}`} onClick={() => setDialog({ kind: 'edit', policy: p })} data-testid={`wh-edit-${p.target?.id}`}>
                        <Pencil className="h-4 w-4" aria-hidden />
                      </Button>
                      <Button variant="ghost" size="sm" aria-label={`${t('workingHours.remove')}: ${label}`} onClick={() => setDialog({ kind: 'remove', policy: p })} data-testid={`wh-remove-${p.target?.id}`}>
                        <Trash2 className="h-4 w-4" aria-hidden />
                      </Button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div className="max-w-6xl space-y-6">
      <div>
        <h1 className="page-title">{t('workingHours.title')}</h1>
        <p className="mt-1 text-sm text-ink-500">{t('workingHours.subtitle')}</p>
      </div>

      {error && <Alert tone="error">{error}</Alert>}

      <Card>
        <CardHeader>
          <CardTitle>{t('workingHours.company.title')}</CardTitle>
        </CardHeader>
        <CardBody className="space-y-4">
          <p className="text-sm text-ink-500">{t('workingHours.company.hint')}</p>
          {loading && !policies ? (
            <PageSpinner />
          ) : (
            <>
              {!company && <p className="text-sm text-ink-500">{t('workingHours.company.unset')}</p>}
              <PolicyForm
                key={policies ? 'loaded' : 'loading'}
                formTestId="wh-company-form"
                idPrefix="wh-company"
                testPrefix="wh-company"
                initial={company ? valuesFromPolicy(company) : DEFAULT_FORM}
                submitLabel={t('action.save')}
                onSubmit={async (input) => {
                  await saveCompanyPolicy(input);
                  setVersion((v) => v + 1);
                  reload();
                }}
              />
            </>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader className="flex-wrap">
          <CardTitle>{t('workingHours.team.title')}</CardTitle>
          <Button size="sm" onClick={() => setDialog({ kind: 'add', scope: 'TEAM' })} disabled={!targets} data-testid="wh-add-team">
            <Plus className="h-4 w-4" aria-hidden />
            {t('workingHours.team.add')}
          </Button>
        </CardHeader>
        <CardBody className="px-0 py-0">{loading && !policies ? <PageSpinner /> : overrideTable('TEAM', teams)}</CardBody>
      </Card>

      <Card>
        <CardHeader className="flex-wrap">
          <CardTitle>{t('workingHours.member.title')}</CardTitle>
          <Button size="sm" onClick={() => setDialog({ kind: 'add', scope: 'MEMBER' })} disabled={!targets} data-testid="wh-add-member">
            <Plus className="h-4 w-4" aria-hidden />
            {t('workingHours.member.add')}
          </Button>
        </CardHeader>
        <CardBody className="px-0 py-0">{loading && !policies ? <PageSpinner /> : overrideTable('MEMBER', members)}</CardBody>
      </Card>

      <EffectivePolicyCard targets={targets} version={version} />

      {dialog?.kind === 'add' && targets && (
        <OverrideModal kind={dialog.scope} targets={targets} takenIds={taken(dialog.scope)} onClose={() => setDialog(null)} onSaved={changed} />
      )}
      {dialog?.kind === 'edit' && targets && (
        <OverrideModal kind={dialog.policy.scope as 'TEAM' | 'MEMBER'} targets={targets} policy={dialog.policy} takenIds={new Set()} onClose={() => setDialog(null)} onSaved={changed} />
      )}
      {dialog?.kind === 'remove' && (
        <ConfirmDialog
          title={t('workingHours.confirm.title', { name: dialog.policy.target?.label ?? '' })}
          body={t('workingHours.confirm.body')}
          confirmLabel={t('workingHours.remove')}
          tone="danger"
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            const id = dialog.policy.target?.id ?? '';
            if (dialog.policy.scope === 'TEAM') await deleteTeamPolicy(id);
            else await deleteMemberPolicy(id);
            changed();
          }}
        />
      )}
    </div>
  );
}
