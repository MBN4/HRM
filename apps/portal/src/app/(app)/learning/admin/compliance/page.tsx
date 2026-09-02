'use client';

import { useState } from 'react';
import { Plus, RefreshCw } from 'lucide-react';
import { PERMISSIONS } from '@hrm/shared';
import { useI18n } from '../../../../../i18n/I18nProvider';
import { useAuth } from '../../../../../lib/auth/AuthContext';
import { useAsync } from '../../../../../lib/useAsync';
import { deactivateRequiredTraining, getComplianceDashboard, listComplianceGaps, listCourses, listRequiredTrainings, runLmsRollup } from '../../../../../lib/api/lms';
import { listBranches } from '../../../../../lib/api/tenancy';
import { ApiError } from '../../../../../lib/api/client';
import { Card, CardBody, CardHeader, CardTitle } from '../../../../../components/ui/Card';
import { Button } from '../../../../../components/ui/Button';
import { Modal } from '../../../../../components/ui/Modal';
import { Alert } from '../../../../../components/ui/Alert';
import { StatusBadge } from '../../../../../components/ui/Badge';
import { PageSpinner } from '../../../../../components/ui/Spinner';
import { Label, Select } from '../../../../../components/ui/Field';
import { RequiredTrainingForm } from '../../../../../components/lms/RequiredTrainingForm';

export default function LearningComplianceAdminPage() {
  const { t } = useI18n();
  const { can } = useAuth();
  const [branchId, setBranchId] = useState('');
  const [addingRule, setAddingRule] = useState(false);
  const [rollupNote, setRollupNote] = useState<string | null>(null);

  const canManage = can(PERMISSIONS.LMS_MANAGE);
  const { data: branches } = useAsync(() => (canManage ? listBranches() : Promise.resolve([])), [canManage]);
  const { data: courses } = useAsync(() => (canManage ? listCourses() : Promise.resolve([])), [canManage]);
  const { data: rules, reload: reloadRules } = useAsync(() => (canManage ? listRequiredTrainings() : Promise.resolve([])), [canManage]);
  const { data: dashboard, loading: dashboardLoading } = useAsync(
    () => (canManage && branchId ? getComplianceDashboard({ branchId }) : Promise.resolve(null)),
    [canManage, branchId],
  );
  const { data: gaps, loading: gapsLoading } = useAsync(() => (canManage && branchId ? listComplianceGaps({ branchId }) : Promise.resolve([])), [canManage, branchId]);

  if (!canManage) {
    return <Alert tone="info">{t('error.forbidden')}</Alert>;
  }

  function courseTitle(courseId: string): string {
    return courses?.find((c) => c.id === courseId)?.title ?? courseId;
  }
  function branchName(id: string | null): string {
    if (!id) return t('lms.admin.branch');
    return branches?.find((b) => b.id === id)?.name ?? id;
  }

  async function handleRunRollup() {
    setRollupNote(null);
    try {
      await runLmsRollup();
      setRollupNote(t('lms.admin.rollupTriggered'));
    } catch (err) {
      setRollupNote(err instanceof ApiError ? err.message : t('error.generic'));
    }
  }

  return (
    <div className="max-w-4xl space-y-6">
      <h1 className="text-xl font-semibold text-ink-900">{t('lms.admin.compliance')}</h1>

      <Card>
        <CardHeader>
          <CardTitle>{t('lms.admin.requiredTrainings')}</CardTitle>
          <Button size="sm" onClick={() => setAddingRule(true)} disabled={!courses || courses.length === 0} data-testid="new-required-training-button">
            <Plus className="h-4 w-4" aria-hidden />
            {t('lms.admin.newRequiredTraining')}
          </Button>
        </CardHeader>
        <CardBody>
          {!rules || rules.length === 0 ? (
            <p className="text-sm text-ink-400">{t('common.noData')}</p>
          ) : (
            <ul className="divide-y divide-ink-100 text-sm">
              {rules.map((rule) => (
                <li key={rule.id} className="flex items-center justify-between py-2" data-testid="required-training-row">
                  <span className="text-ink-800">
                    {courseTitle(rule.courseId)} <span className="text-ink-400">— {branchName(rule.branchId)}</span>
                  </span>
                  <Button variant="ghost" size="sm" onClick={() => deactivateRequiredTraining(rule.id).then(reloadRules)}>
                    {t('lms.admin.deactivateRule')}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('lms.admin.complianceDashboard')}</CardTitle>
          <Button size="sm" variant="secondary" onClick={handleRunRollup} data-testid="run-rollup-button">
            <RefreshCw className="h-4 w-4" aria-hidden />
            {t('lms.admin.refresh')}
          </Button>
        </CardHeader>
        <CardBody className="space-y-4">
          <div className="max-w-xs">
            <Label htmlFor="compliance-branch">{t('lms.admin.branch')}</Label>
            <Select id="compliance-branch" value={branchId} onChange={(e) => setBranchId(e.target.value)} data-testid="compliance-branch-select">
              <option value="">—</option>
              {(branches ?? []).map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </Select>
          </div>

          {rollupNote && <Alert tone="info">{rollupNote}</Alert>}

          {!branchId ? (
            <p className="text-sm text-ink-400">{t('lms.admin.selectBranch')}</p>
          ) : dashboardLoading ? (
            <PageSpinner />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-start text-sm">
                <thead>
                  <tr className="border-b border-ink-100 text-xs uppercase tracking-wide text-ink-400">
                    <th className="py-2 text-start font-medium">{t('lms.admin.course')}</th>
                    <th className="py-2 text-start font-medium">{t('lms.admin.required')}</th>
                    <th className="py-2 text-start font-medium">{t('lms.admin.compliant')}</th>
                    <th className="py-2 text-start font-medium">{t('lms.admin.expiring')}</th>
                    <th className="py-2 text-start font-medium">{t('lms.admin.expired')}</th>
                    <th className="py-2 text-start font-medium">{t('lms.admin.missing')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {(dashboard?.compliance ?? []).map((row, index) => (
                    <tr key={`${row.courseId}-${index}`} data-testid="compliance-dashboard-row">
                      <td className="py-2.5 text-ink-800">{courseTitle(row.courseId)}</td>
                      <td className="py-2.5 text-ink-600">{row.requiredCount}</td>
                      <td className="py-2.5 text-ink-600">{row.compliantCount}</td>
                      <td className="py-2.5 text-ink-600">{row.expiringCount}</td>
                      <td className="py-2.5 text-ink-600">{row.expiredCount}</td>
                      <td className="py-2.5 text-ink-600">{row.missingCount}</td>
                    </tr>
                  ))}
                  {(dashboard?.compliance ?? []).length === 0 && (
                    <tr>
                      <td colSpan={6} className="py-4 text-center text-ink-400">
                        {t('common.noData')}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('lms.admin.complianceGaps')}</CardTitle>
        </CardHeader>
        <CardBody>
          {!branchId ? (
            <p className="text-sm text-ink-400">{t('lms.admin.selectBranch')}</p>
          ) : gapsLoading ? (
            <PageSpinner />
          ) : !gaps || gaps.length === 0 ? (
            <p className="text-sm text-ink-400">{t('common.noData')}</p>
          ) : (
            <ul className="divide-y divide-ink-100 text-sm">
              {gaps.map((gap, index) => (
                <li key={`${gap.employeeId}-${gap.courseId}-${index}`} className="flex items-center justify-between py-2" data-testid="compliance-gap-row">
                  <span className="text-ink-800">
                    {gap.employeeName} <span className="text-ink-400">— {gap.courseTitle}</span>
                  </span>
                  <StatusBadge status={gap.bucket} label={t(`lms.admin.${gap.bucket.toLowerCase()}`)} />
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      {addingRule && (
        <Modal title={t('lms.admin.newRequiredTraining')} onClose={() => setAddingRule(false)}>
          <RequiredTrainingForm
            courses={courses ?? []}
            branches={branches ?? []}
            onCancel={() => setAddingRule(false)}
            onSaved={() => {
              setAddingRule(false);
              reloadRules();
            }}
          />
        </Modal>
      )}
    </div>
  );
}
