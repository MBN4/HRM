import type { LucideIcon } from 'lucide-react';
import { Inbox } from 'lucide-react';

export function EmptyState({ icon: Icon = Inbox, title, description }: { icon?: LucideIcon; title: string; description?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-14 text-center">
      <span className="mb-1 flex h-12 w-12 items-center justify-center rounded-full bg-brand-50 text-brand-600 ring-8 ring-brand-50/50">
        <Icon className="h-6 w-6" aria-hidden />
      </span>
      <p className="text-sm font-semibold text-ink-700">{title}</p>
      {description && <p className="max-w-sm text-sm text-ink-400">{description}</p>}
    </div>
  );
}
