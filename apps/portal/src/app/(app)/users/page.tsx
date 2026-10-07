'use client';

import { useEffect, useMemo, useState } from 'react';
import { KeyRound, Pencil, Plus, Power, PowerOff, Search } from 'lucide-react';
import { PERMISSIONS } from '@hrm/shared';
import { useI18n } from '../../../i18n/I18nProvider';
import { useAuth } from '../../../lib/auth/AuthContext';
import { useAsync } from '../../../lib/useAsync';
import { formatDateTime } from '../../../lib/format';
import { listBranches } from '../../../lib/api/tenancy';
import {
  deactivateUser,
  listAssignableRoles,
  listUsers,
  reactivateUser,
  regenerateTempPassword,
  type TeamUser,
  type TeamUserWithTempPassword,
} from '../../../lib/api/users';
import { Card, CardBody, CardHeader, CardTitle } from '../../../components/ui/Card';
import { Button } from '../../../components/ui/Button';
import { Badge, StatusBadge } from '../../../components/ui/Badge';
import { Input, Select } from '../../../components/ui/Field';
import { Modal } from '../../../components/ui/Modal';
import { Alert } from '../../../components/ui/Alert';
import { ConfirmDialog } from '../../../components/ui/ConfirmDialog';
import { EmptyState } from '../../../components/ui/EmptyState';
import { Pagination } from '../../../components/ui/Pagination';
import { PageSpinner } from '../../../components/ui/Spinner';
import { CreateUserForm } from '../../../components/users/CreateUserForm';
import { EditAccessForm } from '../../../components/users/EditAccessForm';
import { TempPasswordPanel } from '../../../components/users/TempPasswordPanel';

const PAGE_SIZE = 20;

type Dialog =
  | { kind: 'create' }
  | { kind: 'edit'; user: TeamUser }
  | { kind: 'deactivate'; user: TeamUser }
  | { kind: 'reactivate'; user: TeamUser }
  | { kind: 'regenerate'; user: TeamUser }
  | { kind: 'password'; email: string; temporaryPassword: string };

/**
 * Tenant user / team access management (step 7.1) — see
 * docs/conventions/user-management.md. Gated on `user.manage`: without it
 * the nav entry is hidden AND this page renders a no-access notice (the API
 * 403s regardless — the UI gate is convenience, never the control).
 * Distinct from `/team` (the manager's attendance/leave view).
 */
export default function UsersPage() {
  const { t, locale } = useI18n();
  const { can, user: me } = useAuth();
  const canManage = can(PERMISSIONS.USER_MANAGE);

  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [dialog, setDialog] = useState<Dialog | null>(null);

  // Debounce typing into the server-side search so each keystroke isn't a request.
  useEffect(() => {
    const handle = window.setTimeout(() => {
      setSearch(searchInput.trim());
      setPage(1);
    }, 250);
    return () => window.clearTimeout(handle);
  }, [searchInput]);

  const { data, loading, error, reload } = useAsync(
    () => (canManage ? listUsers({ search, status, page, pageSize: PAGE_SIZE }) : Promise.resolve(null)),
    [canManage, search, status, page],
  );
  const { data: roles } = useAsync(() => (canManage ? listAssignableRoles() : Promise.resolve([])), [canManage]);
  const { data: branches } = useAsync(() => (canManage ? listBranches() : Promise.resolve([])), [canManage]);

  const pageCount = useMemo(() => Math.max(1, Math.ceil((data?.total ?? 0) / PAGE_SIZE)), [data?.total]);

  if (!canManage) {
    return <Alert tone="info">{t('users.noAccess')}</Alert>;
  }

  function showPassword(result: TeamUserWithTempPassword) {
    setDialog({ kind: 'password', email: result.email, temporaryPassword: result.temporaryPassword });
    reload();
  }

  return (
    <div className="max-w-6xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="page-title">{t('users.title')}</h1>
          <p className="mt-1 text-sm text-ink-500">{t('users.subtitle')}</p>
        </div>
        <Button onClick={() => setDialog({ kind: 'create' })} disabled={!roles} data-testid="add-user-button">
          <Plus className="h-4 w-4" aria-hidden />
          {t('users.add')}
        </Button>
      </div>

      <Card>
        <CardHeader className="flex-wrap">
          <CardTitle>{t('users.members')}</CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="pointer-events-none absolute inset-y-0 start-3 my-auto h-4 w-4 text-ink-400" aria-hidden />
              <Input
                type="search"
                aria-label={t('users.search')}
                placeholder={t('users.search')}
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                className="ps-9 sm:w-64"
                data-testid="user-search"
              />
            </div>
            {/* The styled Select takes its accessible name from a <label for=id>. */}
            <label htmlFor="user-status-filter" className="sr-only">
              {t('users.filter.status')}
            </label>
            <Select
              id="user-status-filter"
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                setPage(1);
              }}
              data-testid="user-status-filter"
            >
              <option value="">{t('users.filter.all')}</option>
              <option value="ACTIVE">{t('users.status.ACTIVE')}</option>
              <option value="DISABLED">{t('users.status.DISABLED')}</option>
            </Select>
          </div>
        </CardHeader>
        <CardBody className="px-0 py-0">
          {error && (
            <div className="p-5">
              <Alert tone="error">{error}</Alert>
            </div>
          )}
          {loading && !data ? (
            <PageSpinner />
          ) : !data || data.items.length === 0 ? (
            <EmptyState title={t('users.empty')} />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="users-table">
                <thead>
                  <tr className="border-b border-ink-100 text-start text-xs font-semibold uppercase tracking-wide text-ink-500">
                    <th scope="col" className="px-5 py-3 text-start">{t('users.col.user')}</th>
                    <th scope="col" className="px-3 py-3 text-start">{t('users.col.roles')}</th>
                    <th scope="col" className="px-3 py-3 text-start">{t('users.col.branches')}</th>
                    <th scope="col" className="px-3 py-3 text-start">{t('users.col.status')}</th>
                    <th scope="col" className="px-3 py-3 text-start">{t('users.col.lastLogin')}</th>
                    <th scope="col" className="px-5 py-3 text-end">{t('users.col.actions')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {data.items.map((u) => (
                    <UserRow key={u.id} user={u} isSelf={u.id === me?.userId} locale={locale} onAction={setDialog} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="px-5 pb-4">
            <Pagination page={page} pageCount={pageCount} onChange={setPage} />
          </div>
        </CardBody>
      </Card>

      {dialog?.kind === 'create' && roles && (
        <Modal title={t('users.create.title')} onClose={() => setDialog(null)}>
          <CreateUserForm roles={roles} branches={branches ?? []} onCancel={() => setDialog(null)} onCreated={showPassword} />
        </Modal>
      )}

      {dialog?.kind === 'edit' && roles && (
        <Modal title={t('users.edit.title', { email: dialog.user.email })} onClose={() => setDialog(null)}>
          <EditAccessForm
            user={dialog.user}
            roles={roles}
            branches={branches ?? []}
            onCancel={() => setDialog(null)}
            onSaved={() => {
              setDialog(null);
              reload();
            }}
          />
        </Modal>
      )}

      {dialog?.kind === 'deactivate' && (
        <ConfirmDialog
          title={t('users.confirm.deactivate.title', { email: dialog.user.email })}
          body={t('users.confirm.deactivate.body')}
          confirmLabel={t('users.action.deactivate')}
          tone="danger"
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            await deactivateUser(dialog.user.id);
            setDialog(null);
            reload();
          }}
        />
      )}

      {dialog?.kind === 'reactivate' && (
        <ConfirmDialog
          title={t('users.confirm.reactivate.title', { email: dialog.user.email })}
          body={t('users.confirm.reactivate.body')}
          confirmLabel={t('users.action.reactivate')}
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            await reactivateUser(dialog.user.id);
            setDialog(null);
            reload();
          }}
        />
      )}

      {dialog?.kind === 'regenerate' && (
        <ConfirmDialog
          title={t('users.confirm.regenerate.title', { email: dialog.user.email })}
          body={t('users.confirm.regenerate.body')}
          confirmLabel={t('users.action.regenerate')}
          tone="danger"
          onClose={() => setDialog(null)}
          onConfirm={async () => showPassword(await regenerateTempPassword(dialog.user.id))}
        />
      )}

      {dialog?.kind === 'password' && (
        // Closing (Esc / X / "I've copied it") drops the password from state for good.
        <Modal title={t('users.temp.title')} onClose={() => setDialog(null)}>
          <TempPasswordPanel email={dialog.email} temporaryPassword={dialog.temporaryPassword} onDone={() => setDialog(null)} />
        </Modal>
      )}
    </div>
  );
}

function UserRow({ user, isSelf, locale, onAction }: { user: TeamUser; isSelf: boolean; locale: string; onAction: (d: Dialog) => void }) {
  const { t } = useI18n();
  const disabled = user.status === 'DISABLED';
  const iconBtn = 'rounded-md p-1.5 text-ink-500 hover:bg-ink-100 hover:text-ink-800 focus-visible:ring-2 focus-visible:ring-accent-500';
  return (
    <tr data-testid={`user-row-${user.email}`} className={disabled ? 'bg-sand-50/60 text-ink-400' : ''}>
      <td className="px-5 py-3">
        <div className="flex items-center gap-2">
          <span className="font-medium text-ink-900">{user.email}</span>
          {isSelf && <Badge tone="info">{t('users.you')}</Badge>}
        </div>
        {user.mustChangePassword && !disabled && (
          <div className="mt-1">
            <Badge tone="warning">{t('users.awaitingFirstSignIn')}</Badge>
          </div>
        )}
      </td>
      <td className="px-3 py-3">
        <div className="flex flex-wrap gap-1">
          {user.roles.map((r) => (
            <Badge key={r.id}>{r.name}</Badge>
          ))}
        </div>
      </td>
      <td className="px-3 py-3 text-ink-600">{user.branches.length === 0 ? t('users.allBranches') : user.branches.map((b) => b.name).join(', ')}</td>
      <td className="px-3 py-3">
        <StatusBadge status={user.status === 'DISABLED' ? 'CANCELLED' : 'ACTIVE'} label={t(`users.status.${user.status}`)} />
      </td>
      <td className="px-3 py-3 text-ink-600">{user.lastLoginAt ? formatDateTime(user.lastLoginAt, locale) : t('users.neverSignedIn')}</td>
      <td className="px-5 py-3">
        {user.manageable && (
          <div className="flex justify-end gap-1">
            <button type="button" className={iconBtn} title={t('users.action.editAccess')} aria-label={`${t('users.action.editAccess')} — ${user.email}`} onClick={() => onAction({ kind: 'edit', user })} data-testid={`edit-${user.email}`}>
              <Pencil className="h-4 w-4" aria-hidden />
            </button>
            {!disabled && (
              <button type="button" className={iconBtn} title={t('users.action.regenerate')} aria-label={`${t('users.action.regenerate')} — ${user.email}`} onClick={() => onAction({ kind: 'regenerate', user })} data-testid={`regenerate-${user.email}`}>
                <KeyRound className="h-4 w-4" aria-hidden />
              </button>
            )}
            {disabled ? (
              <button type="button" className={iconBtn} title={t('users.action.reactivate')} aria-label={`${t('users.action.reactivate')} — ${user.email}`} onClick={() => onAction({ kind: 'reactivate', user })} data-testid={`reactivate-${user.email}`}>
                <Power className="h-4 w-4" aria-hidden />
              </button>
            ) : (
              <button type="button" className={iconBtn} title={t('users.action.deactivate')} aria-label={`${t('users.action.deactivate')} — ${user.email}`} onClick={() => onAction({ kind: 'deactivate', user })} data-testid={`deactivate-${user.email}`}>
                <PowerOff className="h-4 w-4" aria-hidden />
              </button>
            )}
          </div>
        )}
      </td>
    </tr>
  );
}
