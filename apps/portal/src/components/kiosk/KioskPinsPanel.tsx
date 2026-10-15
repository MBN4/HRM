'use client';

import { useState } from 'react';
import { KeyRound, Trash2 } from 'lucide-react';
import { useI18n } from '../../i18n/I18nProvider';
import { ApiError } from '../../lib/api/client';
import {
  issueKioskPin,
  listKioskPins,
  removeKioskPin,
  type IssuedKioskPin,
  type KioskPinRow,
} from '../../lib/api/kiosk';
import type { Branch } from '../../lib/api/types';
import { useAsync } from '../../lib/useAsync';
import { Alert } from '../ui/Alert';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { CopyField } from '../ui/CopyField';
import { EmptyState } from '../ui/EmptyState';
import { Input, Select } from '../ui/Field';
import { Modal } from '../ui/Modal';
import { PageSpinner } from '../ui/Spinner';

/** Issue / reset / remove employee kiosk PINs. A PIN is generated server-side and shown exactly once. */
export function KioskPinsPanel({ branches }: { branches: Branch[] }) {
  const { t, locale } = useI18n();
  const [branchId, setBranchId] = useState('');
  const [search, setSearch] = useState('');
  const [issued, setIssued] = useState<IssuedKioskPin | null>(null);
  const [removing, setRemoving] = useState<KioskPinRow | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const { data, loading, error, reload } = useAsync(
    () =>
      listKioskPins({
        branchId: branchId || undefined,
        search: search.trim() || undefined,
        limit: 100,
      }),
    [branchId, search],
  );

  async function issue(row: KioskPinRow) {
    setBusyId(row.employeeId);
    setActionError(null);
    try {
      setIssued(await issueKioskPin(row.employeeId));
      reload();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : t('error.generic'));
    } finally {
      setBusyId(null);
    }
  }

  const fmt = (iso: string | null) =>
    iso ? new Date(iso).toLocaleDateString(locale, { dateStyle: 'medium' }) : '—';

  return (
    <div className="space-y-4" data-testid="kiosk-pins-panel">
      <Alert tone="info">{t('kiosk.admin.pins.intro')}</Alert>
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-56">
          <label
            htmlFor="kiosk-pins-branch"
            className="mb-1.5 block text-sm font-medium text-ink-700"
          >
            {t('kiosk.admin.field.branch')}
          </label>
          <Select
            id="kiosk-pins-branch"
            value={branchId}
            onChange={(e) => setBranchId(e.target.value)}
            data-testid="kiosk-pins-branch"
          >
            <option value="">{t('kiosk.admin.pins.allBranches')}</option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="w-64">
          <label
            htmlFor="kiosk-pins-search"
            className="mb-1.5 block text-sm font-medium text-ink-700"
          >
            {t('kiosk.admin.pins.search')}
          </label>
          <Input
            id="kiosk-pins-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('kiosk.admin.pins.searchPlaceholder')}
            data-testid="kiosk-pins-search"
          />
        </div>
      </div>

      {actionError && <Alert tone="error">{actionError}</Alert>}
      {error && <Alert tone="error">{error}</Alert>}

      <Card>
        {loading && !data ? (
          <PageSpinner />
        ) : !data || data.length === 0 ? (
          <EmptyState title={t('kiosk.admin.pins.empty')} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">{t('kiosk.admin.tab.pins')}</caption>
              <thead>
                <tr className="border-b border-ink-100 text-xs text-ink-500">
                  <th scope="col" className="px-5 py-2.5 text-start font-medium">
                    {t('kiosk.admin.pins.employee')}
                  </th>
                  <th scope="col" className="px-3 py-2.5 text-start font-medium">
                    {t('kiosk.field.employeeId')}
                  </th>
                  <th scope="col" className="px-3 py-2.5 text-start font-medium">
                    {t('kiosk.admin.pins.status')}
                  </th>
                  <th scope="col" className="px-3 py-2.5 text-start font-medium">
                    {t('kiosk.admin.pins.lastUsed')}
                  </th>
                  <th scope="col" className="px-5 py-2.5 text-end font-medium">
                    <span className="sr-only">{t('kiosk.admin.actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.map((row) => (
                  <tr
                    key={row.employeeId}
                    className="border-b border-ink-100 last:border-0"
                    data-testid={`kiosk-pin-row-${row.employeeCode}`}
                  >
                    <td className="px-5 py-3 font-medium text-ink-900">{row.name}</td>
                    <td className="px-3 py-3 font-mono text-ink-600" dir="ltr">
                      {row.employeeCode}
                    </td>
                    <td className="px-3 py-3">
                      {row.locked ? (
                        <Badge tone="danger">{t('kiosk.admin.pins.locked')}</Badge>
                      ) : row.hasPin ? (
                        <Badge tone="success">{t('kiosk.admin.pins.set')}</Badge>
                      ) : (
                        <Badge>{t('kiosk.admin.pins.none')}</Badge>
                      )}
                    </td>
                    <td className="px-3 py-3 text-ink-600">{fmt(row.lastUsedAt)}</td>
                    <td className="px-5 py-3">
                      <div className="flex justify-end gap-2">
                        <Button
                          size="sm"
                          variant="secondary"
                          loading={busyId === row.employeeId}
                          onClick={() => void issue(row)}
                          data-testid={`kiosk-pin-issue-${row.employeeCode}`}
                        >
                          <KeyRound className="h-4 w-4" aria-hidden />
                          {row.hasPin ? t('kiosk.admin.pins.reset') : t('kiosk.admin.pins.issue')}
                        </Button>
                        {row.hasPin && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setRemoving(row)}
                            aria-label={t('kiosk.admin.pins.remove')}
                            data-testid={`kiosk-pin-remove-${row.employeeCode}`}
                          >
                            <Trash2 className="h-4 w-4" aria-hidden />
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {issued && (
        <Modal title={t('kiosk.admin.pins.issuedTitle')} onClose={() => setIssued(null)}>
          <div className="space-y-4" data-testid="kiosk-pin-issued">
            <p className="text-sm text-ink-700">
              {t('kiosk.admin.pins.issuedIntro', { name: issued.name, code: issued.employeeCode })}
            </p>
            <CopyField
              value={issued.pin}
              label={t('kiosk.field.pin')}
              copyLabel={t('users.temp.copy')}
              copiedLabel={t('users.temp.copied')}
              data-testid="kiosk-pin-value"
            />
            <Alert tone="info">{t('kiosk.admin.pins.once')}</Alert>
            <div className="flex justify-end">
              <Button onClick={() => setIssued(null)} data-testid="kiosk-pin-done">
                {t('kiosk.admin.token.done')}
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {removing && (
        <ConfirmDialog
          title={t('kiosk.admin.pins.removeTitle')}
          body={t('kiosk.admin.pins.removeBody', { name: removing.name })}
          confirmLabel={t('kiosk.admin.pins.remove')}
          tone="danger"
          onConfirm={async () => {
            await removeKioskPin(removing.employeeId);
            setRemoving(null);
            reload();
          }}
          onClose={() => setRemoving(null)}
        />
      )}
    </div>
  );
}
