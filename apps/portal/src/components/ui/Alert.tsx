import { HTMLAttributes } from 'react';
import { AlertTriangle, CheckCircle2, Info } from 'lucide-react';

type Tone = 'error' | 'success' | 'info';

const TONE_STYLES: Record<Tone, { wrap: string; icon: typeof Info }> = {
  error: { wrap: 'bg-coral-50 text-coral-700 border-coral-200', icon: AlertTriangle },
  success: { wrap: 'bg-brand-50 text-brand-800 border-brand-200', icon: CheckCircle2 },
  info: { wrap: 'bg-sky-50 text-sky-700 border-sky-200', icon: Info },
};

export function Alert({
  tone = 'info',
  children,
  ...rest
}: { tone?: Tone; children: React.ReactNode } & Omit<HTMLAttributes<HTMLDivElement>, 'className' | 'role'>) {
  const { wrap, icon: Icon } = TONE_STYLES[tone];
  return (
    <div className={`flex items-start gap-2 rounded-lg border px-3 py-2.5 text-sm ${wrap}`} role={tone === 'error' ? 'alert' : 'status'} {...rest}>
      <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <span>{children}</span>
    </div>
  );
}
