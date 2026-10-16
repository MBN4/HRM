'use client';

import { useState } from 'react';
import { Building2, GitBranch, Pencil, Plus, Star, Trash2, Users } from 'lucide-react';
import { PERMISSIONS } from '@hrm/shared';
import { useI18n } from '../../../i18n/I18nProvider';
import { useAuth } from '../../../lib/auth/AuthContext';
import { useAsync } from '../../../lib/useAsync';
import { ApiError } from '../../../lib/api/client';
import {
  assignLegalEntityBranches,
  deleteLegalEntity,
  listLegalEntities,
  listLegalEntityEmployees,
  setDefaultLegalEntity,
  type LegalEntity,
  type LegalEntityEmployee,
} from '../../../lib/api/legal-entities';
import { listBranches } from '../../../lib/api/tenancy';
import { Alert } from '../../../components/ui/Alert';
import { Badge } from '../../../components/ui/Badge';
import { Button } from '../../../components/ui/Button';
import { Card } from '../../../components/ui/Card';
import { ConfirmDialog } from '../../../components/ui/ConfirmDialog';
import { EmptyState } from '../../../components/ui/EmptyState';
import { Modal } from '../../../components/ui/Modal';
import { PageSpinner } from '../../../components/ui/Spinner';
import { EntityLogo } from '../../../components/legal-entities/EntityLogo';
import { LegalEntityFormModal } from '../../../components/legal-entities/LegalEntityFormModal';

type Dialog =
  | { kind: 'form'; entity: LegalEntity | null }
  | { kind: 'branches'; entity: LegalEntity }
  | { kind: 'employees'; entity: LegalEntity }
  | { kind: 'delete'; entity: LegalEntity };

/**
 * Legal-entity administration (step 12.1) — the registered companies branches belong to. Their identity
 * (legal name, registration + tax numbers, address) is what payslips, statutory reports and offer letters
 * print as the employer. A branch's own country still drives tax/currency/holidays — an entity is identity
 * only. Gated on `entity.manage`; the API enforces regardless. See docs/conventions/legal-entities.md.
 */
export default function LegalEntitiesPage() {
  const { t } = useI18n();
  const { can } = useAuth();
  const canManage = can(PERMISSIONS.ENTITY_MANAGE);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const {
    data: entities,
    loading,
    error,
    reload,
  } = useAsync(() => (canManage ? listLegalEntities() : Promise.resolve(null)), [canManage]);

  if (!canManage) {
    return <Alert tone="info">{t('entity.noAccess')}</Alert>;
  }

  async function makeDefault(entity: LegalEntity) {
    setActionError(null);
    try {
      await setDefaultLegalEntity(entity.id);
      reload();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : t('error.generic'));
    }
  }

  const close = () => setDialog(null);
  const savedAndClose = () => {
    setDialog(null);
    reload();
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink-900">
            {t('entity.title')}
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-ink-500">{t('entity.subtitle')}</p>
        </div>
        <Button
          onClick={() => setDialog({ kind: 'form', entity: null })}
          data-testid="entity-new-button"
        >
          <Plus className="h-4 w-4" aria-hidden />
          {t('entity.new')}
        </Button>
      </div>

      {error && <Alert tone="error">{error}</Alert>}
      {actionError && <Alert tone="error">{actionError}</Alert>}

      {loading && !entities ? (
        <PageSpinner />
      ) : !entities || entities.length === 0 ? (
        <Card>
          <EmptyState
            icon={Building2}
            title={t('entity.empty')}
            description={t('entity.emptyHint')}
          />
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2" data-testid="entity-list">
          {entities.map((entity) => (
            <Card
              key={entity.id}
              className="space-y-4 p-5"
              data-testid={`entity-card-${entity.legalName}`}
            >
              <div className="flex items-start gap-3">
                <EntityLogo id={entity.id} hasLogo={entity.hasLogo} version={entity.updatedAt} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-base font-semibold text-ink-900">{entity.legalName}</h2>
                    <Badge tone="info">{entity.countryCode}</Badge>
                    {entity.isDefault && <Badge tone="success">{t('entity.default')}</Badge>}
                  </div>
                  <dl className="mt-2 space-y-0.5 text-sm text-ink-600">
                    {entity.registrationNumber && (
                      <div className="flex flex-wrap gap-x-2">
                        <dt className="text-ink-500">{entity.registrationNumberLabel}:</dt>
                        <dd dir="ltr" data-testid="entity-registration-value">
                          {entity.registrationNumber}
                        </dd>
                      </div>
                    )}
                    {entity.taxId && (
                      <div className="flex flex-wrap gap-x-2">
                        <dt className="text-ink-500">{entity.taxIdLabel}:</dt>
                        <dd dir="ltr">{entity.taxId}</dd>
                      </div>
                    )}
                  </dl>
                  {entity.addressLines.length > 0 && (
                    <p className="mt-1 text-sm text-ink-600">{entity.addressLines.join(', ')}</p>
                  )}
                </div>
              </div>

              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-ink-400">
                  {t('entity.branches')}
                </p>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {entity.branches && entity.branches.length > 0 ? (
                    entity.branches.map((b) => (
                      <Badge key={b.id}>
                        {b.name} · {b.countryCode}
                      </Badge>
                    ))
                  ) : (
                    <span className="text-sm text-ink-400">{t('entity.noBranches')}</span>
                  )}
                </div>
              </div>

              <div className="flex flex-wrap gap-2 border-t border-ink-100 pt-3">
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setDialog({ kind: 'form', entity })}
                  data-testid={`entity-edit-${entity.legalName}`}
                >
                  <Pencil className="h-3.5 w-3.5" aria-hidden />
                  {t('entity.edit')}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setDialog({ kind: 'branches', entity })}
                  data-testid={`entity-branches-${entity.legalName}`}
                >
                  <GitBranch className="h-3.5 w-3.5" aria-hidden />
                  {t('entity.manageBranches')}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setDialog({ kind: 'employees', entity })}
                  data-testid={`entity-employees-${entity.legalName}`}
                >
                  <Users className="h-3.5 w-3.5" aria-hidden />
                  {t('entity.employees')}
                </Button>
                {!entity.isDefault && (
                  <Button size="sm" variant="ghost" onClick={() => void makeDefault(entity)}>
                    <Star className="h-3.5 w-3.5" aria-hidden />
                    {t('entity.setDefault')}
                  </Button>
                )}
                {!entity.isDefault && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setDialog({ kind: 'delete', entity })}
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden />
                    {t('entity.delete')}
                  </Button>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}

      {dialog?.kind === 'form' && (
        <LegalEntityFormModal entity={dialog.entity} onClose={close} onSaved={savedAndClose} />
      )}
      {dialog?.kind === 'branches' && (
        <AssignBranchesModal
          entity={dialog.entity}
          entities={entities ?? []}
          onClose={close}
          onSaved={savedAndClose}
        />
      )}
      {dialog?.kind === 'employees' && (
        <EntityEmployeesModal entity={dialog.entity} onClose={close} />
      )}
      {dialog?.kind === 'delete' && (
        <ConfirmDialog
          title={t('entity.deleteTitle')}
          body={t('entity.deleteBody', { name: dialog.entity.legalName })}
          confirmLabel={t('entity.delete')}
          tone="danger"
          onConfirm={async () => {
            await deleteLegalEntity(dialog.entity.id);
            savedAndClose();
          }}
          onClose={close}
        />
      )}
    </div>
  );
}

function AssignBranchesModal({
  entity,
  entities,
  onClose,
  onSaved,
}: {
  entity: LegalEntity;
  entities: LegalEntity[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const { data: branches, loading } = useAsync(() => listBranches(), []);
  const ownerOf = (branchId: string) =>
    entities.find((e) => e.branches?.some((b) => b.id === branchId));
  const [selected, setSelected] = useState<Set<string>>(
    new Set(entity.branches?.map((b) => b.id) ?? []),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const initial = new Set(entity.branches?.map((b) => b.id) ?? []);
  const toAssign = [...selected].filter((id) => !initial.has(id));

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await assignLegalEntityBranches(entity.id, toAssign);
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('error.generic'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title={t('entity.branchesTitle', { name: entity.legalName })} onClose={onClose}>
      <div className="space-y-4" data-testid="entity-branches-modal">
        <p className="text-sm text-ink-500">{t('entity.branchesHint')}</p>
        {error && <Alert tone="error">{error}</Alert>}
        {loading || !branches ? (
          <PageSpinner />
        ) : (
          <ul className="divide-y divide-ink-100 rounded-xl border border-ink-100">
            {branches.map((b) => {
              const owner = ownerOf(b.id);
              const mine = initial.has(b.id);
              return (
                <li key={b.id}>
                  <label className="flex cursor-pointer items-center gap-3 px-4 py-2.5">
                    <input
                      type="checkbox"
                      className="h-4 w-4"
                      checked={selected.has(b.id)}
                      disabled={mine}
                      onChange={(e) =>
                        setSelected((prev) => {
                          const next = new Set(prev);
                          if (e.target.checked) next.add(b.id);
                          else next.delete(b.id);
                          return next;
                        })
                      }
                      data-testid={`entity-branch-${b.name}`}
                    />
                    <span className="flex-1 text-sm text-ink-800">
                      {b.name} <span className="text-ink-400">· {b.countryCode}</span>
                    </span>
                    {owner && !mine && (
                      <span className="text-xs text-ink-400">
                        {t('entity.branchCurrently', { name: owner.legalName })}
                      </span>
                    )}
                  </label>
                </li>
              );
            })}
          </ul>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t('entity.cancel')}
          </Button>
          <Button
            onClick={() => void save()}
            disabled={saving || toAssign.length === 0}
            data-testid="entity-branches-save"
          >
            {t('entity.save')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function EntityEmployeesModal({ entity, onClose }: { entity: LegalEntity; onClose: () => void }) {
  const { t } = useI18n();
  const { data, loading, error } = useAsync<LegalEntityEmployee[]>(
    () => listLegalEntityEmployees(entity.id),
    [entity.id],
  );
  return (
    <Modal title={t('entity.employeesTitle', { name: entity.legalName })} onClose={onClose}>
      <div className="space-y-4" data-testid="entity-employees-modal">
        <p className="text-sm text-ink-500">{t('entity.employeesHint')}</p>
        {error && <Alert tone="error">{error}</Alert>}
        {loading && !data ? (
          <PageSpinner />
        ) : !data || data.length === 0 ? (
          <p className="text-sm text-ink-500">{t('entity.employeesEmpty')}</p>
        ) : (
          <div className="max-h-[50vh] overflow-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">
                {t('entity.employeesTitle', { name: entity.legalName })}
              </caption>
              <thead>
                <tr className="border-b border-ink-100 text-xs text-ink-500">
                  <th scope="col" className="px-3 py-2 text-start font-medium">
                    {t('entity.col.code')}
                  </th>
                  <th scope="col" className="px-3 py-2 text-start font-medium">
                    {t('entity.col.name')}
                  </th>
                  <th scope="col" className="px-3 py-2 text-start font-medium">
                    {t('entity.col.branch')}
                  </th>
                  <th scope="col" className="px-3 py-2 text-start font-medium">
                    {t('entity.col.status')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.map((e) => (
                  <tr key={e.id} className="border-b border-ink-100 last:border-0">
                    <td className="px-3 py-2 font-mono text-xs" dir="ltr">
                      {e.employeeCode}
                    </td>
                    <td className="px-3 py-2 text-ink-900">{e.name}</td>
                    <td className="px-3 py-2 text-ink-600">{e.branchName}</td>
                    <td className="px-3 py-2">
                      <Badge>{e.status}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="flex justify-end">
          <Button variant="secondary" onClick={onClose}>
            {t('entity.close')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
