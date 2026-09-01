type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

const TONE_CLASSES: Record<Tone, string> = {
  neutral: 'bg-ink-100 text-ink-700',
  success: 'bg-brand-100 text-brand-800',
  warning: 'bg-amber-50 text-amber-600',
  danger: 'bg-coral-50 text-coral-600',
  info: 'bg-sky-50 text-sky-700',
};

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: React.ReactNode }) {
  return <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${TONE_CLASSES[tone]}`}>{children}</span>;
}

const STATUS_TONE: Record<string, Tone> = {
  PENDING: 'warning',
  APPROVED: 'success',
  REJECTED: 'danger',
  CANCELED: 'neutral',
  OPEN: 'info',
  CLOSED: 'neutral',
  PRESENT: 'success',
  LATE: 'warning',
  ABSENT: 'danger',
  ON_LEAVE: 'info',
  WEEKEND: 'neutral',
  HOLIDAY: 'neutral',
  // Workflow-instance/step statuses not already covered above (see
  // WorkflowStatusPanel) — additive only, never touch the entries above.
  IN_STEP: 'info',
  ESCALATED: 'danger',
  ACTIVE: 'info',
  SKIPPED: 'neutral',
  // Payroll/Performance statuses not already covered above — additive only.
  DRAFT: 'neutral',
  CALCULATED: 'info',
  FINALIZED: 'success',
  PAID: 'success',
  IN_PROGRESS: 'info',
  PENDING_SIGNOFF: 'warning',
  COMPLETED: 'success',
  SUBMITTED: 'success',
  // Recruitment/Onboarding/Offboarding statuses not already covered above
  // (JobRequisitionStatus/JobPostingStatus/ApplicationStage/OfferStatus/
  // OnboardingProcessStatus) — additive only, never touch the entries above.
  PENDING_APPROVAL: 'warning',
  PUBLISHED: 'success',
  APPLIED: 'neutral',
  SCREEN: 'info',
  INTERVIEW: 'info',
  OFFER: 'warning',
  HIRED: 'success',
  ACCEPTED: 'success',
  DECLINED: 'danger',
  CANCELLED: 'neutral',
};

export function StatusBadge({ status, label }: { status: string; label: string }) {
  return <Badge tone={STATUS_TONE[status] ?? 'neutral'}>{label}</Badge>;
}
