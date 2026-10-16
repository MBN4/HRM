'use client';

import { useState } from 'react';
import { PERMISSIONS } from '@hrm/shared';
import { useI18n } from '../../../i18n/I18nProvider';
import { useAuth } from '../../../lib/auth/AuthContext';
import { useAsync } from '../../../lib/useAsync';
import { listBranches } from '../../../lib/api/tenancy';
import {
  downloadGeneratedReport,
  generateStatutoryReport,
  listGeneratedReports,
  listStatutoryReportDefinitions,
} from '../../../lib/api/statutory-reports';
import { Card, CardBody, CardHeader, CardTitle } from '../../../components/ui/Card';
import { Button } from '../../../components/ui/Button';
import { Alert } from '../../../components/ui/Alert';
import { EmptyState } from '../../../components/ui/EmptyState';
import { PageSpinner } from '../../../components/ui/Spinner';
import { listLegalEntities } from '../../../lib/api/legal-entities';
import { Select, Label, Input } from '../../../components/ui/Field';
import { StatusBadge } from '../../../components/ui/Badge';

const now = new Date();

export default function StatutoryReportsPage() {
  const { t } = useI18n();
  const { can } = useAuth();

  const [entityId, setEntityId] = useState('');
  const [branchId, setBranchId] = useState('');
  const [reportCode, setReportCode] = useState('');
  const [periodYear, setPeriodYear] = useState(String(now.getUTCFullYear()));
  const [periodMonth, setPeriodMonth] = useState(String(now.getUTCMonth() + 1));
  const [periodQuarter, setPeriodQuarter] = useState('1');
  const [generating, setGenerating] = useState(false);

  const canRead = can(PERMISSIONS.STATUTORY_REPORT_READ);
  const canGenerate = can(PERMISSIONS.STATUTORY_REPORT_GENERATE);

  const { data: branches } = useAsync(() => (canRead ? listBranches() : Promise.resolve([])), [canRead]);
  // Step 12.1 — a filing is FOR a legal entity: optionally narrow the branch list to one entity. Only callers holding
  // `entity.manage` can list entities; everyone else simply sees the unfiltered branch list.
  const canSeeEntities = can(PERMISSIONS.ENTITY_MANAGE);
  const { data: entities } = useAsync(() => (canRead && canSeeEntities ? listLegalEntities() : Promise.resolve([])), [canRead, canSeeEntities]);
  const entityBranchIds = entityId ? new Set((entities ?? []).find((e) => e.id === entityId)?.branches?.map((b) => b.id) ?? []) : null;
  const visibleBranches = (branches ?? []).filter((b) => !entityBranchIds || entityBranchIds.has(b.id));
  const filingEntity = (entities ?? []).find((e) => e.branches?.some((b) => b.id === branchId)) ?? null;
  const { data: definitions, loading: definitionsLoading } = useAsync(
    () => (canRead && branchId ? listStatutoryReportDefinitions(branchId) : Promise.resolve([])),
    [canRead, branchId],
  );
  const {
    data: reports,
    loading: reportsLoading,
    reload: reloadReports,
  } = useAsync(() => (canRead && branchId ? listGeneratedReports({ branchId }) : Promise.resolve([])), [canRead, branchId]);

  if (!canRead) {
    return <Alert tone="info">{t('statutoryReports.noAccess')}</Alert>;
  }

  const selectedDefinition = definitions?.find((d) => d.reportCode === reportCode);

  async function handleGenerate() {
    if (!branchId || !reportCode) return;
    setGenerating(true);
    try {
      await generateStatutoryReport({
        branchId,
        reportCode,
        periodYear: Number(periodYear),
        periodMonth: selectedDefinition?.periodType === 'MONTHLY' ? Number(periodMonth) : undefined,
        periodQuarter: selectedDefinition?.periodType === 'QUARTERLY' ? Number(periodQuarter) : undefined,
      });
      reloadReports();
    } finally {
      setGenerating(false);
    }
  }

  function periodLabel(report: { periodType: string; periodYear: number; periodMonth: number | null; periodQuarter: number | null }): string {
    if (report.periodType === 'MONTHLY') return `${report.periodYear}-${String(report.periodMonth).padStart(2, '0')}`;
    if (report.periodType === 'QUARTERLY') return `${report.periodYear}-Q${report.periodQuarter}`;
    return `${report.periodYear}`;
  }

  return (
    <div className="max-w-4xl space-y-6">
      <h1 className="page-title">{t('statutoryReports.title')}</h1>
      <p className="text-sm text-ink-500">{t('statutoryReports.subtitle')}</p>
      <Alert tone="info" data-testid="statutory-reports-compliance-notice">
        {t('statutoryReports.complianceNotice')}
      </Alert>

      <Card>
        <CardHeader>
          <CardTitle>{t('statutoryReports.generate')}</CardTitle>
        </CardHeader>
        <CardBody className="space-y-4">
          {canSeeEntities && (entities ?? []).length > 0 && (
            <div className="max-w-sm">
              <Label htmlFor="sr-entity">{t('entity.filter.label')}</Label>
              <Select id="sr-entity" value={entityId} onChange={(e) => { setEntityId(e.target.value); setBranchId(''); setReportCode(''); }} data-testid="statutory-report-entity-select">
                <option value="">{t('entity.filter.all')}</option>
                {(entities ?? []).map((entity) => (
                  <option key={entity.id} value={entity.id}>
                    {entity.legalName}
                  </option>
                ))}
              </Select>
            </div>
          )}
          {filingEntity && (
            <p className="text-sm text-ink-600" data-testid="statutory-report-filing-for">
              {t('entity.filingFor')}: <span className="font-medium text-ink-900">{filingEntity.legalName}</span>
              {filingEntity.registrationNumber && (
                <span dir="ltr" className="text-ink-500"> · {filingEntity.registrationNumberLabel}: {filingEntity.registrationNumber}</span>
              )}
            </p>
          )}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div>
              <Label htmlFor="sr-branch">{t('statutoryReports.selectBranch')}</Label>
              <Select id="sr-branch" value={branchId} onChange={(e) => { setBranchId(e.target.value); setReportCode(''); }} data-testid="statutory-report-branch-select">
                <option value="">—</option>
                {visibleBranches.map((branch) => (
                  <option key={branch.id} value={branch.id}>
                    {branch.name} ({branch.countryCode})
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label htmlFor="sr-report">{t('statutoryReports.selectReport')}</Label>
              <Select id="sr-report" value={reportCode} onChange={(e) => setReportCode(e.target.value)} disabled={!branchId} data-testid="statutory-report-code-select">
                <option value="">{t('statutoryReports.selectReportPlaceholder')}</option>
                {(definitions ?? []).map((def) => (
                  <option key={def.reportCode} value={def.reportCode}>
                    {def.name}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label htmlFor="sr-year">{t('statutoryReports.periodYear')}</Label>
              <Input id="sr-year" type="number" value={periodYear} onChange={(e) => setPeriodYear(e.target.value)} />
            </div>
            {selectedDefinition?.periodType === 'MONTHLY' && (
              <div>
                <Label htmlFor="sr-month">{t('statutoryReports.periodMonth')}</Label>
                <Input id="sr-month" type="number" min="1" max="12" value={periodMonth} onChange={(e) => setPeriodMonth(e.target.value)} />
              </div>
            )}
            {selectedDefinition?.periodType === 'QUARTERLY' && (
              <div>
                <Label htmlFor="sr-quarter">{t('statutoryReports.periodQuarter')}</Label>
                <Input id="sr-quarter" type="number" min="1" max="4" value={periodQuarter} onChange={(e) => setPeriodQuarter(e.target.value)} />
              </div>
            )}
          </div>

          {selectedDefinition && <p className="text-xs text-ink-400">{selectedDefinition.complianceNote}</p>}

          {branchId && !definitionsLoading && (definitions ?? []).length === 0 && <Alert tone="info">{t('statutoryReports.noDefinitions')}</Alert>}

          {canGenerate && (
            <Button onClick={handleGenerate} disabled={!branchId || !reportCode || generating} data-testid="generate-statutory-report-button">
              {t('statutoryReports.generate')}
            </Button>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('statutoryReports.history')}</CardTitle>
          {branchId && (
            <Button variant="secondary" size="sm" onClick={() => reloadReports()} data-testid="refresh-button">
              {t('statutoryReports.refresh')}
            </Button>
          )}
        </CardHeader>
        <CardBody>
          {!branchId ? null : reportsLoading ? (
            <PageSpinner />
          ) : !reports || reports.length === 0 ? (
            <EmptyState title={t('statutoryReports.noReports')} />
          ) : (
            <ul className="divide-y divide-ink-100" data-testid="statutory-report-history">
              {reports.map((report) => (
                <li key={report.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                  <div>
                    <p className="font-medium text-ink-800">
                      {report.reportCode} — {periodLabel(report)}
                    </p>
                    {report.legalEntity && (
                      <p className="text-xs text-ink-500" data-testid="statutory-report-entity">
                        {report.legalEntity.legalName}
                        {report.legalEntity.registrationNumber ? ` · ${report.legalEntity.registrationNumber}` : ''}
                      </p>
                    )}
                    {report.summary && (
                      <p className="text-xs text-ink-400">
                        {t('statutoryReports.employeeCount')}: {report.summary.employeeCount}
                      </p>
                    )}
                    {report.errorMessage && <p className="text-xs text-red-600">{report.errorMessage}</p>}
                  </div>
                  <div className="flex items-center gap-2">
                    <StatusBadge status={report.status} label={t(`statutoryReports.status.${report.status}`)} />
                    {report.status === 'COMPLETED' && (
                      <>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => downloadGeneratedReport(report.id, 'pdf', `${report.reportCode}-${periodLabel(report)}.pdf`)}
                        >
                          {t('statutoryReports.downloadPdf')}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => downloadGeneratedReport(report.id, 'csv', `${report.reportCode}-${periodLabel(report)}.csv`)}
                        >
                          {t('statutoryReports.downloadCsv')}
                        </Button>
                      </>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
