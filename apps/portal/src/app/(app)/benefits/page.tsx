'use client';

import { useState } from 'react';
import { PERMISSIONS } from '@hrm/shared';
import { useI18n } from '../../../i18n/I18nProvider';
import { useAuth } from '../../../lib/auth/AuthContext';
import { useSession } from '../../../lib/session/SessionProvider';
import { useAsync } from '../../../lib/useAsync';
import { cancelBenefitEnrollment, listBenefitPlans, listMyBenefits } from '../../../lib/api/benefits';
import type { BenefitPlan } from '../../../lib/api/types';
import { formatDate } from '../../../lib/format';
import { Card, CardBody, CardHeader, CardTitle } from '../../../components/ui/Card';
import { Button } from '../../../components/ui/Button';
import { Modal } from '../../../components/ui/Modal';
import { Alert } from '../../../components/ui/Alert';
import { EmptyState } from '../../../components/ui/EmptyState';
import { PageSpinner } from '../../../components/ui/Spinner';
import { StatusBadge } from '../../../components/ui/Badge';
import { BenefitElectForm } from '../../../components/benefits/BenefitElectForm';

export default function BenefitsPage() {
  const { t, locale } = useI18n();
  const { can } = useAuth();
  const { employee } = useSession();
  const [electingPlan, setElectingPlan] = useState<BenefitPlan | null>(null);

  const canView = can(PERMISSIONS.BENEFITS_READ);
  const { data: plans, loading: plansLoading } = useAsync(() => (canView ? listBenefitPlans({ isActive: true }) : Promise.resolve([])), [canView]);
  const { data: enrollments, loading: enrollmentsLoading, reload } = useAsync(() => (canView ? listMyBenefits() : Promise.resolve([])), [canView]);

  if (!canView) {
    return <Alert tone="info">{t('benefits.noAccess')}</Alert>;
  }

  function planName(planId: string): string {
    return plans?.find((p) => p.id === planId)?.name ?? planId.slice(0, 8);
  }

  async function handleCancel(enrollmentId: string) {
    if (!window.confirm(t('benefits.cancelConfirm'))) return;
    await cancelBenefitEnrollment(enrollmentId);
    reload();
  }

  return (
    <div className="max-w-4xl space-y-6">
      <h1 className="text-xl font-semibold text-ink-900">{t('benefits.title')}</h1>

      <Card>
        <CardHeader>
          <CardTitle>{t('benefits.myEnrollments')}</CardTitle>
        </CardHeader>
        <CardBody>
          {enrollmentsLoading ? (
            <PageSpinner />
          ) : !enrollments || enrollments.length === 0 ? (
            <EmptyState title={t('benefits.noEnrollments')} />
          ) : (
            <ul className="divide-y divide-ink-100" data-testid="my-benefit-enrollments">
              {enrollments.map((enrollment) => (
                <li key={enrollment.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                  <div>
                    <p className="font-medium text-ink-800">{planName(enrollment.planId)}</p>
                    <p className="text-xs text-ink-400">
                      {t('benefits.effectiveFrom')}: {formatDate(enrollment.effectiveFrom, locale)}
                      {enrollment.effectiveTo ? ` · ${t('benefits.effectiveTo')}: ${formatDate(enrollment.effectiveTo, locale)}` : ''}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <StatusBadge status={enrollment.status} label={t(`benefits.status.${enrollment.status}`)} />
                    {(enrollment.status === 'ACTIVE' || enrollment.status === 'PENDING_APPROVAL') && can(PERMISSIONS.BENEFITS_ENROLL) && (
                      <Button variant="ghost" size="sm" onClick={() => handleCancel(enrollment.id)}>
                        {t('benefits.cancel')}
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('benefits.availablePlans')}</CardTitle>
        </CardHeader>
        <CardBody>
          {plansLoading ? (
            <PageSpinner />
          ) : !plans || plans.length === 0 ? (
            <EmptyState title={t('benefits.noPlans')} />
          ) : (
            <ul className="divide-y divide-ink-100" data-testid="available-benefit-plans">
              {plans.map((plan) => (
                <li key={plan.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                  <div>
                    <p className="font-medium text-ink-800">{plan.name}</p>
                    <p className="text-xs text-ink-400">{t(`benefits.type.${plan.benefitType}`)}</p>
                  </div>
                  {can(PERMISSIONS.BENEFITS_ENROLL) &&
                    (plan.allowSelfElection ? (
                      <Button size="sm" data-testid={`elect-plan-${plan.code}`} onClick={() => setElectingPlan(plan)}>
                        {t('benefits.elect')}
                      </Button>
                    ) : (
                      <span className="text-xs text-ink-400">{t('benefits.selfElectionNotAllowed')}</span>
                    ))}
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      {electingPlan && (
        <Modal title={t('benefits.electModal.title')} onClose={() => setElectingPlan(null)}>
          <BenefitElectForm
            plan={electingPlan}
            dependents={employee?.dependents ?? []}
            onCancel={() => setElectingPlan(null)}
            onEnrolled={() => {
              setElectingPlan(null);
              reload();
            }}
          />
        </Modal>
      )}
    </div>
  );
}
