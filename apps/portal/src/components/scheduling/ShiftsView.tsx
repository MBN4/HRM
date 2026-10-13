'use client';

import { useState } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useI18n } from '../../i18n/I18nProvider';
import { useAsync } from '../../lib/useAsync';
import { deleteShift, listShifts, type ShiftDefinition } from '../../lib/api/scheduling';
import { Alert } from '../ui/Alert';
import { Button } from '../ui/Button';
import { Card, CardBody, CardHeader, CardTitle } from '../ui/Card';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { EmptyState } from '../ui/EmptyState';
import { PageSpinner } from '../ui/Spinner';
import { useScheduling } from './SchedulingContext';
import { ShiftChip, ShiftTimes } from './ShiftChip';
import { ShiftModal } from './ShiftModal';

/** Define / edit / delete shifts. Only tenant-wide scheduling authority (`working_hours.manage`) may — everyone else gets a read-only list. */
export function ShiftsView() {
  const { t } = useI18n();
  const { people } = useScheduling();
  const canDefine = !!people?.tenantWide;
  const { data: shifts, loading, error, reload } = useAsync(() => listShifts(), []);
  const [dialog, setDialog] = useState<{ kind: 'add' } | { kind: 'edit'; shift: ShiftDefinition } | { kind: 'delete'; shift: ShiftDefinition } | null>(null);

  return (
    <Card>
      <CardHeader className="flex-wrap">
        <CardTitle>{t('scheduling.shifts.title')}</CardTitle>
        {canDefine && (
          <Button size="sm" onClick={() => setDialog({ kind: 'add' })} data-testid="shift-add">
            <Plus className="h-4 w-4" aria-hidden />
            {t('scheduling.shift.add')}
          </Button>
        )}
      </CardHeader>
      <CardBody className="space-y-4 px-0 py-0">
        <div className="space-y-3 px-5 pt-4">
          <p className="text-sm text-ink-500">{t('scheduling.shifts.hint')}</p>
          {!canDefine && people && <Alert tone="info">{t('scheduling.shifts.readOnly')}</Alert>}
          {error && <Alert tone="error">{error}</Alert>}
        </div>
        {loading && !shifts ? (
          <PageSpinner />
        ) : !shifts || shifts.length === 0 ? (
          <EmptyState title={t('scheduling.shifts.empty')} description={canDefine ? t('scheduling.shifts.emptyHint') : undefined} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="shifts-table">
              <caption className="sr-only">{t('scheduling.shifts.title')}</caption>
              <thead>
                <tr className="border-b border-ink-100 text-xs text-ink-500">
                  <th scope="col" className="px-5 py-2.5 text-start font-medium">{t('scheduling.shift.name')}</th>
                  <th scope="col" className="px-3 py-2.5 text-start font-medium">{t('scheduling.shifts.time')}</th>
                  <th scope="col" className="px-3 py-2.5 text-start font-medium">{t('scheduling.shifts.hours')}</th>
                  <th scope="col" className="px-3 py-2.5 text-start font-medium">{t('scheduling.shift.grace')}</th>
                  <th scope="col" className="px-3 py-2.5 text-start font-medium">{t('scheduling.shift.halfDay')}</th>
                  <th scope="col" className="px-3 py-2.5 text-start font-medium">{t('scheduling.shift.minStaffing')}</th>
                  <th scope="col" className="px-3 py-2.5 text-start font-medium">{t('scheduling.shifts.usage')}</th>
                  {canDefine && (
                    <th scope="col" className="px-5 py-2.5 text-end font-medium">
                      <span className="sr-only">{t('workingHours.table.actions')}</span>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {shifts.map((s) => (
                  <tr key={s.id} className="border-b border-ink-100 last:border-0" data-testid={`shift-row-${s.name}`}>
                    <td className="px-5 py-3">
                      <ShiftChip name={s.name} color={s.color} />
                    </td>
                    <td className="px-3 py-3 text-ink-700">
                      <ShiftTimes startTime={s.startTime} endTime={s.endTime} />
                    </td>
                    <td className="px-3 py-3 text-ink-700">{t('scheduling.shifts.hoursValue', { required: s.hours.requiredHours, work: s.hours.workHours, brk: s.hours.breakHours })}</td>
                    <td className="px-3 py-3 text-ink-700">{s.graceMinutes} {t('scheduling.unit.min')}</td>
                    <td className="px-3 py-3 text-ink-700">
                      {s.halfDayThresholdHours === null ? t('scheduling.shifts.halfDerived', { value: s.hours.halfDayThresholdHours }) : `${s.halfDayThresholdHours} h`}
                    </td>
                    <td className="px-3 py-3 text-ink-700">{s.minStaffing ?? '—'}</td>
                    <td className="px-3 py-3 text-ink-700" data-testid={`shift-usage-${s.name}`}>
                      {t('scheduling.shifts.usageValue', { standing: s.usage.standing, roster: s.usage.roster })}
                    </td>
                    {canDefine && (
                      <td className="px-5 py-3">
                        <div className="flex justify-end gap-1">
                          <Button variant="ghost" size="sm" aria-label={`${t('action.edit')}: ${s.name}`} onClick={() => setDialog({ kind: 'edit', shift: s })} data-testid={`shift-edit-${s.name}`}>
                            <Pencil className="h-4 w-4" aria-hidden />
                          </Button>
                          <Button variant="ghost" size="sm" aria-label={`${t('scheduling.action.delete')}: ${s.name}`} onClick={() => setDialog({ kind: 'delete', shift: s })} data-testid={`shift-delete-${s.name}`}>
                            <Trash2 className="h-4 w-4" aria-hidden />
                          </Button>
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="pb-1" />
      </CardBody>

      {dialog?.kind === 'add' && (
        <ShiftModal
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            reload();
          }}
        />
      )}
      {dialog?.kind === 'edit' && (
        <ShiftModal
          shift={dialog.shift}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            reload();
          }}
        />
      )}
      {dialog?.kind === 'delete' && (
        <ConfirmDialog
          title={t('scheduling.shift.deleteTitle', { name: dialog.shift.name })}
          body={t('scheduling.shift.deleteBody')}
          confirmLabel={t('scheduling.action.delete')}
          tone="danger"
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            await deleteShift(dialog.shift.id);
            setDialog(null);
            reload();
          }}
        />
      )}
    </Card>
  );
}
