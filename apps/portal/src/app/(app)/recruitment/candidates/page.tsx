'use client';

import { useRouter } from 'next/navigation';
import { PERMISSIONS } from '@hrm/shared';
import { useI18n } from '../../../../i18n/I18nProvider';
import { useAuth } from '../../../../lib/auth/AuthContext';
import { useAsync } from '../../../../lib/useAsync';
import { listApplications, listCandidates, updateApplicationStage } from '../../../../lib/api/recruitment';
import { Card, CardBody } from '../../../../components/ui/Card';
import { Alert } from '../../../../components/ui/Alert';
import { Select } from '../../../../components/ui/Field';
import { PageSpinner } from '../../../../components/ui/Spinner';
import type { Application, ApplicationStage } from '../../../../lib/api/types';

const STAGES: ApplicationStage[] = ['APPLIED', 'SCREEN', 'INTERVIEW', 'OFFER', 'HIRED', 'REJECTED'];

/** A plain CSS-grid pipeline board, grouped client-side by `stage` — no dedicated "kanban" library, matching this stage's "functional over fancy" bar. */
export default function CandidatePipelinePage() {
  const { t } = useI18n();
  const { can } = useAuth();
  const router = useRouter();

  const canView = can(PERMISSIONS.RECRUITMENT_READ) || can(PERMISSIONS.RECRUITMENT_MANAGE);
  const canWrite = can(PERMISSIONS.RECRUITMENT_WRITE);

  const { data: applications, loading, reload } = useAsync(() => (canView ? listApplications() : Promise.resolve([])), [canView]);
  const { data: candidates } = useAsync(() => (canView ? listCandidates() : Promise.resolve([])), [canView]);

  if (!canView) {
    return <Alert tone="info">{t('error.forbidden')}</Alert>;
  }

  function candidateLabel(candidateId: string): string {
    const candidate = candidates?.find((c) => c.id === candidateId);
    return candidate ? `${candidate.firstName} ${candidate.lastName}` : `${candidateId.slice(0, 8)}…`;
  }

  async function handleStageChange(application: Application, stage: ApplicationStage) {
    await updateApplicationStage(application.id, stage);
    reload();
  }

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold text-ink-900">{t('recruitment.pipeline')}</h1>

      {loading ? (
        <PageSpinner />
      ) : (
        <div className="grid grid-cols-1 gap-4 overflow-x-auto sm:grid-cols-2 lg:grid-cols-6">
          {STAGES.map((stage) => {
            const columnApplications = (applications ?? []).filter((a) => a.stage === stage);
            return (
              <div key={stage} data-testid={`pipeline-column-${stage}`} className="min-w-[200px] space-y-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-ink-400">
                  {t(`recruitment.stage.${stage}`)} ({columnApplications.length})
                </p>
                <div className="space-y-2">
                  {columnApplications.map((application) => (
                    <Card key={application.id} data-testid="application-card">
                      <CardBody className="space-y-2 p-3">
                        <button
                          type="button"
                          className="text-start text-sm font-medium text-brand-700 hover:underline"
                          onClick={() => router.push(`/recruitment/candidates/${application.candidateId}`)}
                        >
                          {candidateLabel(application.candidateId)}
                        </button>
                        {canWrite && (
                          <Select
                            data-testid="application-stage-select"
                            value={application.stage}
                            onChange={(e) => handleStageChange(application, e.target.value as ApplicationStage)}
                          >
                            {STAGES.map((s) => (
                              <option key={s} value={s}>
                                {t(`recruitment.stage.${s}`)}
                              </option>
                            ))}
                          </Select>
                        )}
                      </CardBody>
                    </Card>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
