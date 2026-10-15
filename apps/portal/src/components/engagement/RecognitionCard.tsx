'use client';

import { ArrowRight, Award, EyeOff } from 'lucide-react';
import { useI18n } from '../../i18n/I18nProvider';
import { formatDateTime } from '../../lib/format';
import type { RecognitionView } from '../../lib/api/types';
import { Badge } from '../ui/Badge';
import { Avatar } from './Avatar';

/** One recognition: giver -> recipients, category (+points), message. Shared by /recognition lists and the /feed card. */
export function RecognitionCard({ recognition, onOpenPerson, showDate = true }: { recognition: RecognitionView; onOpenPerson?: (employeeId: string) => void; showDate?: boolean }) {
  const { t, locale } = useI18n();
  const person = (p: { id: string; name: string }) =>
    onOpenPerson ? (
      <button type="button" onClick={() => onOpenPerson(p.id)} className="font-medium text-brand-700 underline-offset-2 hover:underline">
        {p.name}
      </button>
    ) : (
      <span className="font-medium text-ink-900">{p.name}</span>
    );
  return (
    <div data-testid="recognition-card" className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Avatar name={recognition.giver.name} size="sm" />
        {person(recognition.giver)}
        <ArrowRight className="h-4 w-4 text-ink-400 rtl:-scale-x-100" aria-label={t('recognition.gaveTo')} role="img" />
        {recognition.recipients.map((r) => (
          <span key={r.id} className="inline-flex items-center gap-1">
            {person(r)}
          </span>
        ))}
      </div>
      <p className="whitespace-pre-line text-sm text-ink-800">{recognition.message}</p>
      <div className="flex flex-wrap items-center gap-2 text-xs text-ink-400">
        <Badge tone="success">
          <Award className="me-1 h-3 w-3" aria-hidden />
          {recognition.category.name} · {t('recognition.points', { count: recognition.points })}
        </Badge>
        {recognition.visibility === 'PRIVATE' && (
          <Badge tone="neutral">
            <EyeOff className="me-1 h-3 w-3" aria-hidden />
            {t('recognition.visibility.PRIVATE')}
          </Badge>
        )}
        {showDate && <span>{formatDateTime(recognition.createdAt, locale)}</span>}
      </div>
    </div>
  );
}
