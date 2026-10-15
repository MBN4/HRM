'use client';

import { useState } from 'react';
import { Activity, Plus, RefreshCw, ShieldOff, Tablet } from 'lucide-react';
import { PERMISSIONS } from '@hrm/shared';
import { useI18n } from '../../../i18n/I18nProvider';
import { useAuth } from '../../../lib/auth/AuthContext';
import { useAsync } from '../../../lib/useAsync';
import { ApiError } from '../../../lib/api/client';
import {
  getKioskActivity,
  listKiosks,
  revokeKiosk,
  rotateKioskToken,
  updateKiosk,
  type Kiosk,
  type KioskWithToken,
} from '../../../lib/api/kiosk';
import { listBranches } from '../../../lib/api/tenancy';
import { Alert } from '../../../components/ui/Alert';
import { Badge } from '../../../components/ui/Badge';
import { Button } from '../../../components/ui/Button';
import { Card } from '../../../components/ui/Card';
import { ConfirmDialog } from '../../../components/ui/ConfirmDialog';
import { EmptyState } from '../../../components/ui/EmptyState';
import { Modal } from '../../../components/ui/Modal';
import { PageSpinner } from '../../../components/ui/Spinner';
import { tabPanelProps, Tabs } from '../../../components/ui/Tabs';
import { KioskPinsPanel } from '../../../components/kiosk/KioskPinsPanel';
import { KioskTokenPanel, RegisterKioskModal } from '../../../components/kiosk/RegisterKioskModal';

type Tab = 'devices' | 'pins';
type Dialog =
  | { kind: 'register' }
  | { kind: 'rotate'; kiosk: Kiosk }
  | { kind: 'revoke'; kiosk: Kiosk }
  | { kind: 'activity'; kiosk: Kiosk }
  | { kind: 'token'; kiosk: KioskWithToken };

/**
 * Kiosk administration (step 11.1) — register shared attendance terminals, issue/rotate/revoke their device
 * tokens (shown once, like an API key), see activity/last-seen, and manage employee kiosk PINs. Gated on
 * `kiosk.manage`; the API enforces regardless. See docs/conventions/kiosk.md.
 */
export default function KiosksPage() {
  const { t, locale } = useI18n();
  const { can } = useAuth();
  const canManage = can(PERMISSIONS.KIOSK_MANAGE);

  const [tab, setTab] = useState<Tab>('devices');
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const {
    data: kiosks,
    loading,
    error,
    reload,
  } = useAsync(() => (canManage ? listKiosks() : Promise.resolve(null)), [canManage]);
  const { data: branches } = useAsync(
    () => (canManage ? listBranches() : Promise.resolve([])),
    [canManage],
  );

  if (!canManage) {
    return <Alert tone="info">{t('kiosk.admin.noAccess')}</Alert>;
  }

  const fmtSeen = (iso: string | null) =>
    iso
      ? new Date(iso).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' })
      : t('kiosk.admin.neverSeen');

  async function toggle(k: Kiosk, patch: { requirePhoto?: boolean; biometricEnabled?: boolean }) {
    setActionError(null);
    try {
      await updateKiosk(k.id, patch);
      reload();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : t('error.generic'));
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink-900">
            {t('kiosk.admin.title')}
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-ink-500">{t('kiosk.admin.subtitle')}</p>
        </div>
        {tab === 'devices' && (
          <Button
            onClick={() => setDialog({ kind: 'register' })}
            data-testid="kiosk-register-button"
          >
            <Plus className="h-4 w-4" aria-hidden />
            {t('kiosk.admin.register.button')}
          </Button>
        )}
      </div>

      <Tabs
        label={t('kiosk.admin.title')}
        idPrefix="kiosk-admin"
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'devices', label: t('kiosk.admin.tab.devices'), testId: 'kiosk-tab-devices' },
          { value: 'pins', label: t('kiosk.admin.tab.pins'), testId: 'kiosk-tab-pins' },
        ]}
      />

      {actionError && <Alert tone="error">{actionError}</Alert>}

      {tab === 'devices' && (
        <div {...tabPanelProps('kiosk-admin', 'devices')} className="space-y-4">
          {error && <Alert tone="error">{error}</Alert>}
          <Card>
            {loading && !kiosks ? (
              <PageSpinner />
            ) : !kiosks || kiosks.length === 0 ? (
              <EmptyState
                icon={Tablet}
                title={t('kiosk.admin.empty')}
                description={t('kiosk.admin.emptyHint')}
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm" data-testid="kiosk-table">
                  <caption className="sr-only">{t('kiosk.admin.tab.devices')}</caption>
                  <thead>
                    <tr className="border-b border-ink-100 text-xs text-ink-500">
                      <th scope="col" className="px-5 py-2.5 text-start font-medium">
                        {t('kiosk.admin.col.device')}
                      </th>
                      <th scope="col" className="px-3 py-2.5 text-start font-medium">
                        {t('kiosk.admin.col.status')}
                      </th>
                      <th scope="col" className="px-3 py-2.5 text-start font-medium">
                        {t('kiosk.admin.col.lastSeen')}
                      </th>
                      <th scope="col" className="px-3 py-2.5 text-start font-medium">
                        {t('kiosk.admin.col.options')}
                      </th>
                      <th scope="col" className="px-5 py-2.5 text-end font-medium">
                        <span className="sr-only">{t('kiosk.admin.actions')}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {kiosks.map((k) => (
                      <tr
                        key={k.id}
                        className="border-b border-ink-100 align-top last:border-0"
                        data-testid={`kiosk-row-${k.name}`}
                      >
                        <td className="px-5 py-3">
                          <p className="font-medium text-ink-900">{k.name}</p>
                          <p className="text-ink-500">{k.branchName}</p>
                          <p className="mt-0.5 font-mono text-xs text-ink-400" dir="ltr">
                            {k.tokenPrefix}…
                          </p>
                        </td>
                        <td className="px-3 py-3">
                          {k.status === 'REVOKED' ? (
                            <Badge tone="danger">{t('kiosk.admin.status.revoked')}</Badge>
                          ) : k.online ? (
                            <Badge tone="success">{t('kiosk.admin.status.online')}</Badge>
                          ) : (
                            <Badge>{t('kiosk.admin.status.offline')}</Badge>
                          )}
                        </td>
                        <td className="px-3 py-3 text-ink-600">{fmtSeen(k.lastSeenAt)}</td>
                        <td className="px-3 py-3">
                          <div className="space-y-1.5 text-ink-600">
                            <label className="flex items-center gap-2">
                              <input
                                type="checkbox"
                                className="h-4 w-4"
                                checked={k.requirePhoto}
                                onChange={(e) => void toggle(k, { requirePhoto: e.target.checked })}
                                data-testid={`kiosk-photo-${k.name}`}
                              />
                              {t('kiosk.admin.opt.photo')}
                            </label>
                            <label className="flex items-center gap-2">
                              <input
                                type="checkbox"
                                className="h-4 w-4"
                                checked={k.biometricEnabled}
                                onChange={(e) =>
                                  void toggle(k, { biometricEnabled: e.target.checked })
                                }
                              />
                              {t('kiosk.admin.opt.biometric')}
                            </label>
                          </div>
                        </td>
                        <td className="px-5 py-3">
                          <div className="flex flex-wrap justify-end gap-2">
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() => setDialog({ kind: 'activity', kiosk: k })}
                              data-testid={`kiosk-activity-${k.name}`}
                            >
                              <Activity className="h-4 w-4" aria-hidden />
                              {t('kiosk.admin.activity')}
                            </Button>
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() => setDialog({ kind: 'rotate', kiosk: k })}
                              data-testid={`kiosk-rotate-${k.name}`}
                            >
                              <RefreshCw className="h-4 w-4" aria-hidden />
                              {t('kiosk.admin.rotate')}
                            </Button>
                            {k.status === 'ACTIVE' && (
                              <Button
                                size="sm"
                                variant="danger"
                                onClick={() => setDialog({ kind: 'revoke', kiosk: k })}
                                data-testid={`kiosk-revoke-${k.name}`}
                              >
                                <ShieldOff className="h-4 w-4" aria-hidden />
                                {t('kiosk.admin.revoke')}
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
        </div>
      )}

      {tab === 'pins' && (
        <div {...tabPanelProps('kiosk-admin', 'pins')}>
          <KioskPinsPanel branches={branches ?? []} />
        </div>
      )}

      {dialog?.kind === 'register' && (
        <RegisterKioskModal
          branches={branches ?? []}
          onClose={() => setDialog(null)}
          onRegistered={reload}
        />
      )}
      {dialog?.kind === 'token' && (
        <Modal title={t('kiosk.admin.token.title')} onClose={() => setDialog(null)}>
          <KioskTokenPanel kiosk={dialog.kiosk} onDone={() => setDialog(null)} />
        </Modal>
      )}
      {dialog?.kind === 'rotate' && (
        <ConfirmDialog
          title={t('kiosk.admin.rotate.title')}
          body={t('kiosk.admin.rotate.body', { name: dialog.kiosk.name })}
          confirmLabel={t('kiosk.admin.rotate')}
          onConfirm={async () => {
            const rotated = await rotateKioskToken(dialog.kiosk.id);
            reload();
            setDialog({ kind: 'token', kiosk: rotated });
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'revoke' && (
        <ConfirmDialog
          title={t('kiosk.admin.revoke.title')}
          body={t('kiosk.admin.revoke.body', { name: dialog.kiosk.name })}
          confirmLabel={t('kiosk.admin.revoke')}
          tone="danger"
          onConfirm={async () => {
            await revokeKiosk(dialog.kiosk.id);
            setDialog(null);
            reload();
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'activity' && (
        <ActivityModal kiosk={dialog.kiosk} onClose={() => setDialog(null)} />
      )}
    </div>
  );
}

function ActivityModal({ kiosk, onClose }: { kiosk: Kiosk; onClose: () => void }) {
  const { t, locale } = useI18n();
  const { data, loading, error } = useAsync(() => getKioskActivity(kiosk.id), [kiosk.id]);
  const fmt = (iso: string | null) =>
    iso ? new Date(iso).toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' }) : '—';
  return (
    <Modal title={t('kiosk.admin.activity.title', { name: kiosk.name })} onClose={onClose}>
      {loading && !data ? (
        <PageSpinner />
      ) : error ? (
        <Alert tone="error">{error}</Alert>
      ) : !data || data.length === 0 ? (
        <EmptyState title={t('kiosk.admin.activity.empty')} />
      ) : (
        <table className="w-full text-sm" data-testid="kiosk-activity-table">
          <caption className="sr-only">{t('kiosk.admin.activity')}</caption>
          <thead>
            <tr className="text-xs text-ink-500">
              <th scope="col" className="py-2 text-start font-medium">
                {t('kiosk.admin.pins.employee')}
              </th>
              <th scope="col" className="py-2 text-start font-medium">
                {t('attendance.clockIn')}
              </th>
              <th scope="col" className="py-2 text-start font-medium">
                {t('attendance.clockOut')}
              </th>
            </tr>
          </thead>
          <tbody>
            {data.map((a) => (
              <tr key={a.recordId} className="border-t border-ink-100">
                <td className="py-2 text-ink-900">{a.employeeName}</td>
                <td className="py-2 text-ink-600">{fmt(a.clockInAt)}</td>
                <td className="py-2 text-ink-600">{fmt(a.clockOutAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  );
}
