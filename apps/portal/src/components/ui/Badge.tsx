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
  // Operations modules statuses (step 3.1) — ExpenseClaimStatus/
  // AssetStatus/AssetAssignmentStatus/TicketStatus/TicketPriority not
  // already covered above — additive only, never touch the entries above.
  REIMBURSED: 'success',
  AVAILABLE: 'success',
  IN_MAINTENANCE: 'warning',
  RETIRED: 'neutral',
  ASSIGNED: 'info',
  RETURNED: 'neutral',
  RESOLVED: 'success',
  LOW: 'neutral',
  MEDIUM: 'info',
  HIGH: 'warning',
  URGENT: 'danger',
  // LMS statuses (step 3.2) — CourseStatus/EnrollmentStatus/
  // CertificationStatus/compliance buckets not already covered above —
  // additive only, never touch the entries above.
  ENROLLED: 'info',
  RENEWED: 'neutral',
  EXPIRING: 'warning',
  MISSING: 'danger',
  ARCHIVED: 'neutral',
  // Billing (step 4.2) — SubscriptionStatus/InvoiceStatus not already
  // covered above (ACTIVE/CANCELED/DRAFT/PAID are reused as-is) —
  // additive only.
  TRIAL: 'info',
  PAST_DUE: 'warning',
  VOID: 'neutral',
  UNCOLLECTIBLE: 'danger',
  // White-label / branding (step 4.3) — DomainVerificationStatus/
  // DomainCertStatus not already covered above (PENDING/FAILED are reused
  // as-is) — additive only.
  PENDING_VERIFICATION: 'warning',
  VERIFIED: 'success',
  NONE: 'neutral',
  ISSUED: 'success',
  FAILED: 'danger',
  // Data migration & onboarding toolkit (step 3.5.1) — ImportBatchStatus
  // not already covered above (FAILED is reused as-is) — additive only.
  UPLOADED: 'neutral',
  VALIDATING: 'info',
  DRY_RUN_COMPLETE: 'info',
  COMMITTING: 'info',
  COMMITTED: 'success',
  COMMITTED_WITH_ERRORS: 'warning',
  // Benefits administration (step 3.5.2) — BenefitEnrollmentStatus not
  // already covered above (PENDING_APPROVAL/ACTIVE/CANCELLED are reused
  // as-is) — additive only.
  EXPIRED: 'neutral',
  // E-signatures (step 3.5.3) — SignatureRequestStatus/SignerStatus not
  // already covered above (DRAFT/COMPLETED/CANCELED/DECLINED/EXPIRED are
  // reused as-is) — additive only.
  SENT: 'info',
  PARTIALLY_SIGNED: 'warning',
  VIEWED: 'info',
  SIGNED: 'success',
  // Statutory / government reporting (step 3.5.4) — GeneratedReportStatus
  // not already covered above (PENDING/COMPLETED/FAILED are reused as-is)
  // — additive only.
  GENERATING: 'info',
};

export function StatusBadge({ status, label }: { status: string; label: string }) {
  return <Badge tone={STATUS_TONE[status] ?? 'neutral'}>{label}</Badge>;
}
