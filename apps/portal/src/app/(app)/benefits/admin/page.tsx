'use client';

import { useState } from 'react';
import { Plus } from 'lucide-react';
import { PERMISSIONS } from '@hrm/shared';
import { useI18n } from '../../../../i18n/I18nProvider';
import { useAuth } from '../../../../lib/auth/AuthContext';
import { useAsync } from '../../../../lib/useAsync';
import { listBenefitPlans, listBenefitEnrollments, getBenefitStatutory, getBenefitCostReport } from '../../../../lib/api/benefits';
import { listBranches } from '../../../../lib/api/tenancy';
import { Card, CardBody, CardHeader, CardTitle } from '../../../../components/ui/Card';
import { Button } from '../../../../components/ui/Button';
import { Modal } from '../../../../components/ui/Modal';
import { Alert } from '../../../../components/ui/Alert';
import { EmptyState } from '../../../../components/ui/EmptyState';
import { PageSpinner } from '../../../../components/ui/Spinner';
import { Select, Label, Input } from '../../../../components/ui/Field';
import { StatusBadge } from '../../../../components/ui/Badge';
import { BenefitPlanForm } from '../../../../components/benefits/BenefitPlanForm';
import { BenefitEnrollForm } from '../../../../components/benefits/BenefitEnrollForm';

const now = new Date();

export default function BenefitsAdminPage() {
  const { t } = useI18n();
  const { can } = useAuth();
  const [addingPlan, setAddingPlan] = useState(false);
  const [enrolling, setEnrolling] = useState(false);
  const [statutoryBranchId, setStatutoryBranchId] = useState('');
  const [reportBranchId, setReportBranchId] = useState('');
  const [reportPeriodYear, setReportPeriodYear] = useState(String(now.getUTCFullYear()));
  const [reportPeriodMonth, setReportPeriodMonth] = useState(String(now.getUTCMonth() + 1));

  const canManage = can(PERMISSIONS.BENEFITS_MANAGE);
  const { data: plans, loading: plansLoading, reload: reloadPlans } = useAsync(() => (canManage ? listBenefitPlans() : Promise.resolve([])), [canManage]);
  const { data: enrollments, loading: enrollmentsLoading, reload: reloadEnrollments } = useAsync(() => (canManage ? listBenefitEnrollments() : Promise.resolve([])), [canManage]);
  const { data: branches } = useAsync(() => (canManage ? listBranches() : Promise.resolve([])), [canManage]);

  const { data: statutory, loading: statutoryLoading } = useAsync(
    () => (canManage && statutoryBranchId ? getBenefitStatutory(statutoryBranchId) : Promise.resolve(null)),
    [canManage, statutoryBranchId],
  );

  const { data: costReport, loading: costReportLoading } = useAsync(
    () =>
      canManage && reportBranchId && reportPeriodYear && reportPeriodMonth
        ? getBenefitCostReport({ periodYear: Number(reportPeriodYear), periodMonth: Number(reportPeriodMonth), branchId: reportBranchId })
        : Promise.resolve(null),
    [canManage, reportBranchId, reportPeriodYear, reportPeriodMonth],
  );

  if (!canManage) {
    return <Alert tone="info">{t('benefits.noAccess')}</Alert>;
  }

  function planName(planId: string): string {
    return plans?.find((p) => p.id === planId)?.name ?? planId.slice(0, 8);
  }

  const hasSalaryView = costReport ? costReport.plans.every((p) => 'employeeTotal' in p) || costReport.plans.length === 0 : true;

  return (
    <div className="max-w-4xl space-y-6">
      <h1 className="text-xl font-semibold text-ink-900">{t('benefits.admin.title')}</h1>

      <Card>
        <CardHeader>
          <CardTitle>{t('benefits.admin.plans')}</CardTitle>
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" onClick={() => setEnrolling(true)} disabled={!plans || plans.length === 0}>
              {t('benefits.admin.enroll')}
            </Button>
            <Button size="sm" onClick={() => setAddingPlan(true)} data-testid="new-benefit-plan-button">
              <Plus className="h-4 w-4" aria-hidden />
              {t('benefits.admin.newPlan')}
            </Button>
          </div>
        </CardHeader>
        <CardBody>
          {plansLoading ? (
            <PageSpinner />
          ) : !plans || plans.length === 0 ? (
            <EmptyState title={t('benefits.noPlans')} />
          ) : (
            <ul className="divide-y divide-ink-100" data-testid="admin-benefit-plans">
              {plans.map((plan) => (
                <li key={plan.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                  <div>
                    <p className="font-medium text-ink-800">
                      {plan.name} <span className="text-ink-400">({plan.code})</span>
                    </p>
                    <p className="text-xs text-ink-400">
                      {t(`benefits.type.${plan.benefitType}`)} · {t(`benefits.admin.costBasis.${plan.costBasis}`)}
                    </p>
                  </div>
                  {!plan.isActive && <StatusBadge status="RETIRED" label={t('common.no')} />}
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('benefits.admin.allEnrollments')}</CardTitle>
        </CardHeader>
        <CardBody>
          {enrollmentsLoading ? (
            <PageSpinner />
          ) : !enrollments || enrollments.length === 0 ? (
            <EmptyState title={t('benefits.noEnrollments')} />
          ) : (
            <ul className="divide-y divide-ink-100" data-testid="admin-benefit-enrollments">
              {enrollments.map((enrollment) => (
                <li key={enrollment.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                  <span className="text-ink-800">{planName(enrollment.planId)}</span>
                  <StatusBadge status={enrollment.status} label={t(`benefits.status.${enrollment.status}`)} />
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('benefits.admin.statutory')}</CardTitle>
        </CardHeader>
        <CardBody className="space-y-3">
          <Select value={statutoryBranchId} onChange={(e) => setStatutoryBranchId(e.target.value)} data-testid="statutory-branch-select">
            <option value="">{t('benefits.admin.statutorySelectBranch')}</option>
            {(branches ?? []).map((branch) => (
              <option key={branch.id} value={branch.id}>
                {branch.name} ({branch.countryCode})
              </option>
            ))}
          </Select>
          {statutoryLoading ? (
            <PageSpinner />
          ) : statutory ? (
            <ul className="divide-y divide-ink-100 text-sm" data-testid="statutory-components-list">
              {statutory.components.map((component) => (
                <li key={component.name} className="flex items-center justify-between py-1.5">
                  <span className="text-ink-700">{component.name}</span>
                  <span className="text-ink-400">
                    {component.appliesTo} · {component.kind}
                  </span>
                </li>
              ))}
              {statutory.components.length === 0 && <li className="py-1.5 text-ink-400">{t('common.noData')}</li>}
            </ul>
          ) : null}
          <p className="text-xs text-ink-400">{t('benefits.admin.statutoryNote')}</p>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('benefits.admin.costReport')}</CardTitle>
        </CardHeader>
        <CardBody className="space-y-4">
          <div className="grid grid-cols-3 gap-3">
            <div>
              <Label htmlFor="report-branch">{t('common.branch')}</Label>
              <Select id="report-branch" value={reportBranchId} onChange={(e) => setReportBranchId(e.target.value)} data-testid="cost-report-branch-select">
                <option value="">{t('benefits.admin.statutorySelectBranch')}</option>
                {(branches ?? []).map((branch) => (
                  <option key={branch.id} value={branch.id}>
                    {branch.name}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label htmlFor="report-year">{t('benefits.admin.costReportPeriod')} — {t('common.date')} (Y)</Label>
              <Input id="report-year" type="number" value={reportPeriodYear} onChange={(e) => setReportPeriodYear(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="report-month">{t('benefits.admin.costReportPeriod')} (M)</Label>
              <Input id="report-month" type="number" min="1" max="12" value={reportPeriodMonth} onChange={(e) => setReportPeriodMonth(e.target.value)} />
            </div>
          </div>

          {costReportLoading ? (
            <PageSpinner />
          ) : !reportBranchId ? null : !hasSalaryView ? (
            <Alert tone="info">{t('benefits.admin.costReportNoAccess')}</Alert>
          ) : costReport && (costReport.plans.length > 0 || costReport.statutory.length > 0) ? (
            <div className="space-y-4" data-testid="benefit-cost-report">
              <div>
                <h3 className="mb-1.5 text-sm font-semibold text-ink-800">{t('benefits.admin.costReportPlans')}</h3>
                <table className="w-full text-start text-sm">
                  <thead>
                    <tr className="text-xs uppercase tracking-wide text-ink-400">
                      <th className="py-1 text-start font-medium">{t('benefits.admin.name')}</th>
                      <th className="py-1 text-start font-medium">{t('benefits.admin.costReportEmployee')}</th>
                      <th className="py-1 text-start font-medium">{t('benefits.admin.costReportEmployer')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink-100">
                    {costReport.plans.map((line) => (
                      <tr key={line.planId}>
                        <td className="py-1.5 text-ink-700">{line.planName}</td>
                        <td className="py-1.5 text-ink-700">{line.employeeTotal}</td>
                        <td className="py-1.5 text-ink-700">{line.employerTotal}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div>
                <h3 className="mb-1.5 text-sm font-semibold text-ink-800">{t('benefits.admin.costReportStatutory')}</h3>
                <table className="w-full text-start text-sm">
                  <thead>
                    <tr className="text-xs uppercase tracking-wide text-ink-400">
                      <th className="py-1 text-start font-medium">{t('benefits.admin.name')}</th>
                      <th className="py-1 text-start font-medium">{t('benefits.admin.costReportEmployee')}</th>
                      <th className="py-1 text-start font-medium">{t('benefits.admin.costReportEmployer')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink-100">
                    {costReport.statutory.map((line) => (
                      <tr key={line.name}>
                        <td className="py-1.5 text-ink-700">{line.name}</td>
                        <td className="py-1.5 text-ink-700">{line.employeeTotal}</td>
                        <td className="py-1.5 text-ink-700">{line.employerTotal}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <EmptyState title={t('benefits.admin.costReportEmpty')} />
          )}
        </CardBody>
      </Card>

      {addingPlan && (
        <Modal title={t('benefits.admin.newPlan')} onClose={() => setAddingPlan(false)}>
          <BenefitPlanForm
            onCancel={() => setAddingPlan(false)}
            onSaved={() => {
              setAddingPlan(false);
              reloadPlans();
            }}
          />
        </Modal>
      )}

      {enrolling && (
        <Modal title={t('benefits.admin.enroll')} onClose={() => setEnrolling(false)}>
          <BenefitEnrollForm
            plans={plans ?? []}
            onCancel={() => setEnrolling(false)}
            onEnrolled={() => {
              setEnrolling(false);
              reloadEnrollments();
            }}
          />
        </Modal>
      )}
    </div>
  );
}
