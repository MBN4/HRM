import { Loader2 } from 'lucide-react';

export function Spinner({ className = 'h-6 w-6' }: { className?: string }) {
  return <Loader2 className={`animate-spin text-brand-500 ${className}`} aria-hidden />;
}

export function PageSpinner() {
  // A WCAG 4.1.3 role="status" here was tried and reverted (Phase 6.2): on
  // a full page navigation this spinner can be visible at the SAME instant
  // as Next.js's own always-present route announcer
  // (#__next-route-announcer__, role="alert") — real portal specs asserting
  // `getByRole('alert').or(getByRole('status'))` (e.g. payroll.spec.ts's
  // RBAC "forbidden notice" tests) then hit a genuine Playwright strict-
  // mode violation (2 elements resolved). Documented as a manual-audit-only
  // gap in docs/conventions/security-hardening.md rather than shipped with
  // a real regression.
  return (
    <div className="flex items-center justify-center py-16">
      <Spinner />
    </div>
  );
}
