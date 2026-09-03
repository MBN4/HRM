import { Loader2 } from 'lucide-react';

export function Spinner({ className = 'h-6 w-6' }: { className?: string }) {
  return <Loader2 className={`animate-spin text-brand-500 ${className}`} aria-hidden />;
}

export function PageSpinner() {
  return (
    <div className="flex items-center justify-center py-16">
      <Spinner />
    </div>
  );
}
