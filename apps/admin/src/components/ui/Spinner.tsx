import { Loader2 } from 'lucide-react';

export function Spinner({ className = 'h-6 w-6' }: { className?: string }) {
  return <Loader2 className={`animate-spin text-brand-500 ${className}`} aria-hidden />;
}

export function PageSpinner() {
  // A WCAG 4.1.3 role="status" here was tried and reverted (Phase 6.2) —
  // see apps/portal/src/components/ui/Spinner.tsx's identical doc comment
  // for the real strict-mode-violation regression it caused against an
  // existing spec. Documented as a manual-audit-only gap in
  // docs/conventions/security-hardening.md instead.
  return (
    <div className="flex items-center justify-center py-16">
      <Spinner />
    </div>
  );
}
