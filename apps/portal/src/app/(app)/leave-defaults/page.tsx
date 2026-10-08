'use client';

import { FormEvent, useEffect, useState } from 'react';
import { PERMISSIONS, LEAVE_TYPES } from '@hrm/shared';
import { useI18n } from '../../../i18n/I18nProvider';
import { useAuth } from '../../../lib/auth/AuthContext';
import { useAsync } from '../../../lib/useAsync';
import { ApiError } from '../../../lib/api/client';
import { getLeaveDefaults, saveLeaveDefaults, type LeaveDefaultDays, type LeaveDefaultsCountry } from '../../../lib/api/leave';
import { Alert } from '../../../components/ui/Alert';
import { Badge } from '../../../components/ui/Badge';
import { Button } from '../../../components/ui/Button';
import { Card, CardBody, CardHeader, CardTitle } from '../../../components/ui/Card';
import { EmptyState } from '../../../components/ui/EmptyState';
import { FieldError, Input } from '../../../components/ui/Field';
import { PageSpinner } from '../../../components/ui/Spinner';

const KEY_BY_TYPE: Record<(typeof LEAVE_TYPES)[number], keyof LeaveDefaultDays> = {
  ANNUAL: 'annualDays',
  SICK: 'sickDays',
  MATERNITY: 'maternityDays',
  PATERNITY: 'paternityDays',
};

function CountryCard({ country, onSaved }: { country: LeaveDefaultsCountry; onSaved: () => void }) {
  const { t } = useI18n();
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(LEAVE_TYPES.map((lt) => [lt, String(country.effective[KEY_BY_TYPE[lt]])])));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // After a save the parent reloads: adopt the server's values without remounting (which would drop the success message).
  const effectiveKey = JSON.stringify(country.effective);
  useEffect(() => {
    setValues(Object.fromEntries(LEAVE_TYPES.map((lt) => [lt, String(country.effective[KEY_BY_TYPE[lt]])])));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveKey]);

  const dirty = LEAVE_TYPES.some((lt) => Number(values[lt]) !== country.effective[KEY_BY_TYPE[lt]]);

  /** Mirrors the server's bound so the legal-minimum message shows inline before a round trip. */
  function validate(): Partial<LeaveDefaultDays> | null {
    const next: Record<string, string> = {};
    const input: Partial<LeaveDefaultDays> = {};
    for (const lt of LEAVE_TYPES) {
      const key = KEY_BY_TYPE[lt];
      const raw = values[lt].trim();
      const n = Number(raw);
      if (raw === '' || !Number.isFinite(n) || n < 0 || n > 366) next[lt] = t('leaveDefaults.invalid');
      else if (n < country.legalFloor[key]) next[lt] = t('leaveDefaults.belowFloor', { type: t(`leave.type.${lt}`), floor: country.legalFloor[key], country: country.countryCode });
      else if (n !== country.effective[key]) input[key] = n;
    }
    setErrors(next);
    return Object.keys(next).length > 0 ? null : input;
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setServerError(null);
    setSuccess(null);
    const input = validate();
    if (!input || Object.keys(input).length === 0) return;
    setBusy(true);
    try {
      const res = await saveLeaveDefaults(country.countryCode, input);
      setSuccess(t('leaveDefaults.saved', { created: res.applied.balancesCreated, raised: res.applied.balancesRaised, members: res.applied.members }));
      onSaved();
    } catch (err) {
      setServerError(err instanceof ApiError ? err.message : t('error.generic'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card data-testid={`ld-card-${country.countryCode}`}>
      <CardHeader>
        <CardTitle>{t('leaveDefaults.country', { country: country.countryCode, count: country.memberCount })}</CardTitle>
      </CardHeader>
      <CardBody>
        <form onSubmit={submit} noValidate className="space-y-4">
          <div className="overflow-x-auto">
            <table className="w-full text-start text-sm">
              <thead>
                <tr>
                  <th className="py-2 text-start font-medium">{t('leaveDefaults.col.type')}</th>
                  <th className="py-2 text-start font-medium">{t('leaveDefaults.col.floor')}</th>
                  <th className="py-2 text-start font-medium">{t('leaveDefaults.col.current')}</th>
                  <th className="py-2 text-start font-medium">{t('leaveDefaults.col.new')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {LEAVE_TYPES.map((lt) => {
                  const key = KEY_BY_TYPE[lt];
                  const id = `ld-${country.countryCode}-${lt}`;
                  return (
                    <tr key={lt} data-testid={`ld-row-${country.countryCode}-${lt}`}>
                      <td className="py-3 pe-4 font-medium text-ink-800">
                        <label htmlFor={id}>{t(`leave.type.${lt}`)}</label>
                      </td>
                      <td className="py-3 pe-4 tabular-nums text-ink-600" data-testid={`${id}-floor`}>
                        {country.legalFloor[key]}
                      </td>
                      <td className="py-3 pe-4 tabular-nums text-ink-800">
                        <span data-testid={`${id}-current`}>{country.effective[key]}</span>{' '}
                        <Badge tone={country.override?.[key] !== undefined ? 'info' : 'neutral'}>
                          {country.override?.[key] !== undefined ? t('leaveDefaults.override') : t('leaveDefaults.inherited')}
                        </Badge>
                      </td>
                      <td className="py-3">
                        <Input
                          id={id}
                          data-testid={id}
                          type="number"
                          inputMode="decimal"
                          min={country.legalFloor[key]}
                          max={366}
                          step="0.5"
                          value={values[lt]}
                          aria-invalid={!!errors[lt]}
                          aria-describedby={errors[lt] ? `${id}-err` : undefined}
                          onChange={(e) => setValues((v) => ({ ...v, [lt]: e.target.value }))}
                          className="w-28"
                        />
                        {errors[lt] && (
                          <div id={`${id}-err`} data-testid={`${id}-error`}>
                            <FieldError>{errors[lt]}</FieldError>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {serverError && <Alert tone="error">{serverError}</Alert>}
          {success && (
            <Alert tone="success" data-testid={`ld-success-${country.countryCode}`}>
              {success}
            </Alert>
          )}
          <div className="flex items-center gap-2">
            <Button type="submit" loading={busy} disabled={!dirty} data-testid={`ld-save-${country.countryCode}`}>
              {t('leaveDefaults.save')}
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={!dirty || busy}
              onClick={() => {
                setValues(Object.fromEntries(LEAVE_TYPES.map((lt) => [lt, String(country.effective[KEY_BY_TYPE[lt]])])));
                setErrors({});
                setServerError(null);
              }}
            >
              {t('leaveDefaults.reset')}
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}

/**
 * Default leave allocation (step 8.1 Part 4) — per-country default days for each leave type, applied org-wide
 * through the existing leave balance model. Gated on `leave.defaults.manage`; the API enforces regardless.
 * See docs/conventions/leave.md § Default leave allocation.
 */
export default function LeaveDefaultsPage() {
  const { t } = useI18n();
  const { can } = useAuth();
  const canManage = can(PERMISSIONS.LEAVE_DEFAULTS_MANAGE);
  const { data, loading, error, reload } = useAsync(() => (canManage ? getLeaveDefaults() : Promise.resolve(null)), [canManage]);

  if (!canManage) return <Alert tone="info">{t('leaveDefaults.noAccess')}</Alert>;

  return (
    <div className="max-w-4xl space-y-6" data-testid="leave-defaults-page">
      <div>
        <h1 className="page-title">{t('leaveDefaults.title')}</h1>
        <p className="page-subtitle">{t('leaveDefaults.subtitle')}</p>
      </div>
      <Alert tone="info">{t('leaveDefaults.goingForward')}</Alert>
      {error && <Alert tone="error">{error}</Alert>}
      {loading && !data ? (
        <PageSpinner />
      ) : !data || data.countries.length === 0 ? (
        <EmptyState title={t('leaveDefaults.empty')} />
      ) : (
        data.countries.map((c) => (
          <CountryCard
            key={c.countryCode}
            country={c}
            onSaved={reload}
          />
        ))
      )}
    </div>
  );
}
