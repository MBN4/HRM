'use client';

import { useState } from 'react';
import { useI18n } from '../../../i18n/I18nProvider';
import { useAuth } from '../../../lib/auth/AuthContext';
import { useSession } from '../../../lib/session/SessionProvider';
import { useAsync } from '../../../lib/useAsync';
import { listBranches } from '../../../lib/api/tenancy';
import { formatCurrency, formatDate } from '../../../lib/format';
import { PERMISSIONS } from '@hrm/shared';
import { Card, CardBody, CardHeader, CardTitle } from '../../../components/ui/Card';
import { Button } from '../../../components/ui/Button';
import { Modal } from '../../../components/ui/Modal';
import { Alert } from '../../../components/ui/Alert';
import { PageSpinner } from '../../../components/ui/Spinner';
import { ProfileEditForm } from '../../../components/profile/ProfileEditForm';

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-ink-400">{label}</dt>
      <dd className="mt-0.5 text-sm text-ink-800">{value || '—'}</dd>
    </div>
  );
}

export default function ProfilePage() {
  const { t, locale } = useI18n();
  const { can } = useAuth();
  const { employee, employeeLoading, pack, refreshEmployee } = useSession();
  const { data: branches } = useAsync(() => listBranches(), []);
  const [editing, setEditing] = useState(false);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);

  if (employeeLoading) return <PageSpinner />;
  if (!employee) {
    return <Alert tone="info">{t('profile.noEmployeeProfile')}</Alert>;
  }

  const branchName = branches?.find((b) => b.id === employee.branchId)?.name ?? employee.branchId;
  const canEdit = can(PERMISSIONS.EMPLOYEE_WRITE);
  const currencyCode = pack?.locale.currencyCode;
  const hasCompensationKey = 'compensation' in employee;

  return (
    <div className="max-w-4xl space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-ink-900">
            {employee.firstName} {employee.lastName}
          </h1>
          <p className="text-sm text-ink-500">{employee.employeeCode}</p>
        </div>
        {canEdit && (
          <Button onClick={() => setEditing(true)} variant="secondary">
            {t('profile.edit')}
          </Button>
        )}
      </div>

      {!canEdit && <Alert tone="info">{t('profile.readOnlyNotice')}</Alert>}
      {savedMessage && <Alert tone="success">{savedMessage}</Alert>}

      <Card>
        <CardHeader>
          <CardTitle>{t('profile.personalInfo')}</CardTitle>
        </CardHeader>
        <CardBody>
          <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Field label={t('profile.firstName')} value={employee.firstName} />
            <Field label={t('profile.lastName')} value={employee.lastName} />
            <Field label={t('profile.personalEmail')} value={employee.personalEmail} />
            <Field label={t('profile.phone')} value={employee.phone} />
            <Field label={t('profile.dateOfBirth')} value={formatDate(employee.dateOfBirth, locale)} />
            <Field label={t('profile.gender')} value={employee.gender} />
          </dl>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('profile.employment')}</CardTitle>
        </CardHeader>
        <CardBody>
          <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Field label={t('profile.branch')} value={branchName} />
            <Field label={t('profile.employmentType')} value={employee.employmentType} />
            <Field label={t('profile.joinDate')} value={formatDate(employee.joinDate, locale)} />
            <Field label={t('profile.status')} value={employee.status} />
          </dl>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('profile.compensation')}</CardTitle>
        </CardHeader>
        <CardBody>
          {!hasCompensationKey ? (
            <p data-testid="no-salary-access" className="text-sm text-ink-400">
              {t('profile.noSalaryAccess')}
            </p>
          ) : employee.compensation ? (
            <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field
                label={t('profile.baseSalary')}
                value={
                  <span data-testid="salary-value">
                    {formatCurrency(employee.compensation.baseSalary, employee.compensation.salaryCurrency ?? currencyCode, locale)}
                  </span>
                }
              />
            </dl>
          ) : (
            <p className="text-sm text-ink-400">{t('common.noData')}</p>
          )}
        </CardBody>
      </Card>

      {employee.bankDetails && (
        <Card>
          <CardHeader>
            <CardTitle>{t('profile.bankDetails')}</CardTitle>
          </CardHeader>
          <CardBody>
            <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label={t('profile.bankName')} value={employee.bankDetails.bankName} />
              <Field label={t('profile.accountNumber')} value={employee.bankDetails.accountNumber} />
            </dl>
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>{t('profile.emergencyContacts')}</CardTitle>
        </CardHeader>
        <CardBody>
          {employee.emergencyContacts.length === 0 ? (
            <p className="text-sm text-ink-400">{t('common.noData')}</p>
          ) : (
            <ul className="space-y-2">
              {employee.emergencyContacts.map((c) => (
                <li key={c.id} className="text-sm text-ink-700">
                  <span className="font-medium">{c.name}</span> · {c.relationship} · {c.phone}
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('profile.dependents')}</CardTitle>
        </CardHeader>
        <CardBody>
          {employee.dependents.length === 0 ? (
            <p className="text-sm text-ink-400">{t('common.noData')}</p>
          ) : (
            <ul className="space-y-2">
              {employee.dependents.map((d) => (
                <li key={d.id} className="text-sm text-ink-700">
                  <span className="font-medium">{d.name}</span> · {d.relationship}
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      {editing && (
        <Modal title={t('profile.editTitle')} onClose={() => setEditing(false)}>
          <ProfileEditForm
            employee={employee}
            onCancel={() => setEditing(false)}
            onSaved={() => {
              setEditing(false);
              setSavedMessage(t('profile.saved'));
              void refreshEmployee();
            }}
          />
        </Modal>
      )}
    </div>
  );
}
