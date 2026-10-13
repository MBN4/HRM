'use client';

import { useMemo } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useI18n } from '../../i18n/I18nProvider';
import { formatWindowTitle, stepAnchor, windowFor } from '../../lib/scheduling';
import { ymdInTimeZone } from '../../lib/attendance-status';
import { Button } from '../ui/Button';
import { Label } from '../ui/Field';
import { SegmentedControl } from '../ui/SegmentedControl';
import { Select } from '../ui/Select';
import { useScheduling } from './SchedulingContext';

/** Prev / next / today, week-month toggle and the team filter — shared by the roster and the coverage view. */
export function WindowToolbar({ children }: { children?: React.ReactNode }) {
  const { t, locale } = useI18n();
  const { people, anchor, setAnchor, mode, setMode, departmentId, setDepartmentId } = useScheduling();
  const { from, to } = windowFor(anchor, mode);
  const today = useMemo(() => ymdInTimeZone(new Date(), Intl.DateTimeFormat().resolvedOptions().timeZone), []);
  const isCurrent = today >= from && today <= to;

  const names = (people?.departments ?? []).map((d) => d.name);
  return (
    <div className="flex flex-wrap items-end gap-x-4 gap-y-3" data-testid="window-toolbar">
      <div className="flex items-center gap-1">
        <Button variant="secondary" size="sm" aria-label={t('scheduling.nav.prev')} data-testid="window-prev" onClick={() => setAnchor(stepAnchor(anchor, mode, -1))}>
          <ChevronLeft className="h-4 w-4 rtl:rotate-180" aria-hidden />
        </Button>
        <h2 className="min-w-[11rem] px-2 text-center text-sm font-semibold text-ink-900" aria-live="polite" data-testid="window-title" data-from={from} data-to={to}>
          {formatWindowTitle(from, to, mode, locale)}
        </h2>
        <Button variant="secondary" size="sm" aria-label={t('scheduling.nav.next')} data-testid="window-next" onClick={() => setAnchor(stepAnchor(anchor, mode, 1))}>
          <ChevronRight className="h-4 w-4 rtl:rotate-180" aria-hidden />
        </Button>
        <Button variant="ghost" size="sm" disabled={isCurrent} data-testid="window-today" onClick={() => setAnchor(today)}>
          {t('scheduling.nav.today')}
        </Button>
      </div>

      <SegmentedControl
        label={t('scheduling.view.label')}
        value={mode}
        onChange={setMode}
        options={[
          { value: 'week', label: t('scheduling.view.week'), testId: 'view-week' },
          { value: 'month', label: t('scheduling.view.month'), testId: 'view-month' },
        ]}
      />

      <div className="w-56">
        <Label htmlFor="scheduling-team">{t('scheduling.team.filter')}</Label>
        <Select id="scheduling-team" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} data-testid="scheduling-team" searchable={false}>
          <option value="">{t('scheduling.team.all')}</option>
          {(people?.departments ?? []).map((d) => (
            <option key={d.id} value={d.id}>
              {names.filter((n) => n === d.name).length > 1 ? `${d.name} (${d.branchName})` : d.name}
            </option>
          ))}
        </Select>
      </div>
      {children}
    </div>
  );
}
