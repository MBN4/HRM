'use client';

import { FormEvent, useState } from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import { createTicket } from '../../lib/api/helpdesk';
import { ApiError } from '../../lib/api/client';
import { TICKET_PRIORITIES } from '@hrm/shared';
import type { TicketCategory, TicketPriority } from '../../lib/api/types';
import { Button } from '../ui/Button';
import { Input, Label, Select, Textarea } from '../ui/Field';
import { Alert } from '../ui/Alert';

export function NewTicketForm({ categories, onSubmitted, onCancel }: { categories: TicketCategory[]; onSubmitted: () => void; onCancel: () => void }) {
  const { t } = useI18n();
  const [categoryId, setCategoryId] = useState(categories[0]?.id ?? '');
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<TicketPriority>('MEDIUM');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await createTicket({ categoryId, subject, description, priority });
      onSubmitted();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('error.generic'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <Label htmlFor="ticket-category">{t('helpdesk.category')}</Label>
        <Select id="ticket-category" value={categoryId} onChange={(e) => setCategoryId(e.target.value)} required>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      </div>
      <div>
        <Label htmlFor="ticket-subject">{t('helpdesk.subject')}</Label>
        <Input id="ticket-subject" value={subject} onChange={(e) => setSubject(e.target.value)} required />
      </div>
      <div>
        <Label htmlFor="ticket-description">{t('helpdesk.description')}</Label>
        <Textarea id="ticket-description" rows={4} value={description} onChange={(e) => setDescription(e.target.value)} required />
      </div>
      <div>
        <Label htmlFor="ticket-priority">{t('helpdesk.priority')}</Label>
        <Select id="ticket-priority" value={priority} onChange={(e) => setPriority(e.target.value as TicketPriority)}>
          {TICKET_PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {t(`helpdesk.priority.${p}`)}
            </option>
          ))}
        </Select>
      </div>

      {error && <Alert tone="error">{error}</Alert>}

      <div className="flex justify-end gap-2 border-t border-ink-100 pt-4">
        <Button type="button" variant="secondary" onClick={onCancel}>
          {t('action.cancel')}
        </Button>
        <Button type="submit" loading={submitting} data-testid="submit-new-ticket-button">
          {t('helpdesk.newTicket')}
        </Button>
      </div>
    </form>
  );
}
