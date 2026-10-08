'use client';

import { useMemo, useState } from 'react';
import { PERMISSIONS } from '@hrm/shared';
import { useI18n } from '../../i18n/I18nProvider';
import { useAuth } from '../../lib/auth/AuthContext';
import { useSession } from '../../lib/session/SessionProvider';
import { useAsync } from '../../lib/useAsync';
import { listEmployees } from '../../lib/api/employees';
import { Label } from '../ui/Field';
import { Select } from '../ui/Select';
import { MonthlyAttendanceGraph } from './MonthlyAttendanceGraph';

/**
 * The monthly graph + (for managers/HR) a "pick a member" selector. Defaults to the caller's own month.
 * No permission logic lives here beyond OFFERING the picker to `attendance.approve` / `working_hours.manage`
 * holders — `GET /attendance/status` is what enforces who may see whom (own always; HR/admin/CEO within branch
 * scope; managers their reporting chain). A refused pick surfaces the API's 403/404 as a friendly message.
 */
export function MemberMonthView({ compact = false, refreshKey = 0 }: { compact?: boolean; refreshKey?: number }) {
  const { t } = useI18n();
  const { can } = useAuth();
  const { employee } = useSession();
  const canPick = can(PERMISSIONS.ATTENDANCE_APPROVE) || can(PERMISSIONS.WORKING_HOURS_MANAGE);
  const [memberId, setMemberId] = useState<string>('');

  const { data: people } = useAsync(
    () => (canPick ? listEmployees({ pageSize: 100 }).then((r) => r.data) : Promise.resolve([])),
    [canPick],
  );
  const options = useMemo(
    () => (people ?? []).filter((p) => p.id !== employee?.id).sort((a, b) => `${a.firstName} ${a.lastName}`.localeCompare(`${b.firstName} ${b.lastName}`)),
    [people, employee?.id],
  );

  return (
    <div className="space-y-4">
      {canPick && (
        <div className="max-w-sm">
          <Label htmlFor="attendance-member">{t('attendance.month.pickMember')}</Label>
          <Select id="attendance-member" searchable value={memberId} onChange={(e) => setMemberId(e.target.value)} data-testid="attendance-member-select">
            <option value="">{t('attendance.month.me')}</option>
            {options.map((p) => (
              <option key={p.id} value={p.id}>
                {p.firstName} {p.lastName} ({p.employeeCode})
              </option>
            ))}
          </Select>
          <p className="mt-1 text-xs text-ink-400">{t('attendance.month.pickHelp')}</p>
        </div>
      )}
      <MonthlyAttendanceGraph employeeId={memberId || undefined} compact={compact} refreshKey={refreshKey} />
    </div>
  );
}
