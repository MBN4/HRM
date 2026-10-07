'use client';

import { useMemo, useState } from 'react';
import { ArrowRight, Check } from 'lucide-react';
import { useI18n } from '../../i18n/I18nProvider';
import { useAsync } from '../../lib/useAsync';
import { getEffectiveWorkingHours, type WorkingHoursSource, type WorkingHoursTargets } from '../../lib/api/working-hours';
import { Alert } from '../ui/Alert';
import { Badge } from '../ui/Badge';
import { Card, CardBody, CardHeader, CardTitle } from '../ui/Card';
import { Input, Label } from '../ui/Field';
import { PageSpinner } from '../ui/Spinner';
import { Select } from '../ui/Select';

const LAYERS: WorkingHoursSource[] = ['MEMBER', 'TEAM', 'COMPANY', 'COUNTRY_PACK'];
const TONE: Record<WorkingHoursSource, 'info' | 'success' | 'warning' | 'neutral'> = {
  MEMBER: 'info',
  TEAM: 'success',
  COMPANY: 'warning',
  COUNTRY_PACK: 'neutral',
};

/** The precedence demo: resolves one member's working hours and says which layer won. `version` bumps after any edit so the card refetches. */
export function EffectivePolicyCard({ targets, version }: { targets: WorkingHoursTargets | null; version: number }) {
  const { t } = useI18n();
  const [employeeId, setEmployeeId] = useState('');
  const [date, setDate] = useState('');

  const { data, loading, error } = useAsync(
    () => (employeeId ? getEffectiveWorkingHours(employeeId, date || undefined) : Promise.resolve(null)),
    [employeeId, date, version],
  );

  const sourceDept = useMemo(() => {
    if (!data?.sourceDepartmentId || !targets) return null;
    return targets.departments.find((d) => d.id === data.sourceDepartmentId) ?? null;
  }, [data, targets]);
  const memberDeptId = useMemo(() => targets?.employees.find((e) => e.id === employeeId)?.departmentId ?? null, [targets, employeeId]);
  const inherited = data?.source === 'TEAM' && !!data.sourceDepartmentId && data.sourceDepartmentId !== memberDeptId;

  const p = data?.policy;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('workingHours.effective.title')}</CardTitle>
      </CardHeader>
      <CardBody className="space-y-4">
        <p className="text-sm text-ink-500">{t('workingHours.effective.hint')}</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="wh-effective-member">{t('workingHours.member.label')}</Label>
            <Select id="wh-effective-member" searchable value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} data-testid="wh-effective-member">
              <option value="">{t('workingHours.member.pick')}</option>
              {(targets?.employees ?? []).map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name} ({e.code})
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="wh-effective-date">{t('workingHours.effective.date')}</Label>
            <Input id="wh-effective-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} data-testid="wh-effective-date" />
          </div>
        </div>

        {error && <Alert tone="error">{error}</Alert>}
        {employeeId && loading && !data && <PageSpinner />}

        {!employeeId && <p className="text-sm text-ink-500">{t('workingHours.effective.empty')}</p>}

        {employeeId && data && p && (
          <div className="space-y-4" aria-live="polite">
            <ol className="flex flex-wrap items-center gap-2" aria-label={t('workingHours.precedence.label')} data-testid="wh-precedence" data-winner={data.source}>
              {LAYERS.map((layer, i) => {
                const win = layer === data.source;
                return (
                  <li key={layer} className="flex items-center gap-2" data-layer={layer} data-winner={win ? 'true' : 'false'} aria-current={win ? 'true' : undefined}>
                    <span
                      className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm ${
                        win ? 'border-accent-500 bg-brand-50 font-semibold text-brand-800' : 'border-ink-200 bg-surface text-ink-600'
                      }`}
                    >
                      {win && <Check className="h-4 w-4" aria-hidden />}
                      {i + 1}. {t(`workingHours.source.${layer}.short`)}
                    </span>
                    {i < LAYERS.length - 1 && <ArrowRight className="h-4 w-4 text-ink-400 rtl:rotate-180" aria-hidden />}
                  </li>
                );
              })}
            </ol>

            <div className="flex flex-wrap items-center gap-3">
              <span className="text-sm font-medium text-ink-700">{t('workingHours.effective.source')}</span>
              <span data-testid="wh-effective-source" data-source={data.source}>
                <Badge tone={TONE[data.source]}>{t(`workingHours.source.${data.source}`)}</Badge>
              </span>
              <span className="text-sm text-ink-500">
                {data.source === 'TEAM' && sourceDept
                  ? inherited
                    ? t('workingHours.source.TEAM.inherited', { team: sourceDept.name })
                    : t('workingHours.source.TEAM.named', { team: sourceDept.name })
                  : t(`workingHours.source.${data.source}.hint`)}
              </span>
            </div>

            <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <Item label={t('workingHours.field.startTime')} value={p.startTime} testId="wh-effective-start" />
              <Item label={t('workingHours.field.workHours')} value={`${p.workHours} h`} testId="wh-effective-work" />
              <Item label={t('workingHours.field.breakHours')} value={`${p.breakHours} h`} testId="wh-effective-break" />
              <Item label={t('workingHours.effective.required')} value={`${p.requiredHours} h`} testId="wh-effective-required" />
              <Item label={t('workingHours.field.grace')} value={`${p.graceMinutes} min`} testId="wh-effective-grace" />
              <Item
                label={t('workingHours.field.halfDay')}
                value={`${p.halfDayThresholdHours} h${p.halfDayThresholdDerived ? ` (${t('workingHours.effective.derived')})` : ''}`}
                testId="wh-effective-halfday"
              />
              <Item label={t('workingHours.effective.timezone')} value={data.timezone} testId="wh-effective-timezone" />
              <Item label={t('workingHours.effective.date')} value={data.date} testId="wh-effective-resolved-date" />
            </dl>
          </div>
        )}
      </CardBody>
    </Card>
  );
}

function Item({ label, value, testId }: { label: string; value: string; testId: string }) {
  return (
    <div className="rounded-lg border border-ink-100 bg-surface px-3 py-2">
      <dt className="text-xs text-ink-500">{label}</dt>
      <dd className="mt-0.5 text-sm font-semibold text-ink-900" data-testid={testId}>
        {value}
      </dd>
    </div>
  );
}
