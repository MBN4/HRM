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
  TRIAL: 'info',
  ACTIVE: 'success',
  SUSPENDED: 'danger',
  CANCELLED: 'neutral',
  STARTER: 'neutral',
  PROFESSIONAL: 'info',
  ENTERPRISE: 'success',
  PLATFORM_OWNER: 'danger',
  PLATFORM_SUPPORT: 'info',
  SHARED_DB: 'neutral',
  DB_PER_TENANT: 'info',
  // Billing (step 4.2) — SubscriptionStatus/InvoiceStatus not already
  // covered above (TRIAL/ACTIVE reused as-is) — additive only.
  PAST_DUE: 'warning',
  CANCELED: 'neutral',
  DRAFT: 'neutral',
  OPEN: 'info',
  PAID: 'success',
  VOID: 'neutral',
  UNCOLLECTIBLE: 'danger',
  // White-label / branding (step 4.3) — DomainVerificationStatus/
  // DomainCertStatus not already covered above — additive only.
  PENDING_VERIFICATION: 'warning',
  VERIFIED: 'success',
  FAILED: 'danger',
  NONE: 'neutral',
  ISSUED: 'success',
};

export function StatusBadge({ status }: { status: string }) {
  return <Badge tone={STATUS_TONE[status] ?? 'neutral'}>{status.replace(/_/g, ' ')}</Badge>;
}
