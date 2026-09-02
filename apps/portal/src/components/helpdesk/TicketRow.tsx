'use client';

import { FormEvent, useState } from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import { useAsync } from '../../lib/useAsync';
import { addTicketAttachment, addTicketComment, assignTicket, downloadTicketAttachment, listTicketAttachments, listTicketComments, updateTicketStatus } from '../../lib/api/helpdesk';
import { ApiError } from '../../lib/api/client';
import { listEmployees } from '../../lib/api/employees';
import { formatDateTime } from '../../lib/format';
import { TICKET_STATUSES } from '@hrm/shared';
import type { Ticket, TicketCategory, TicketStatus } from '../../lib/api/types';
import { StatusBadge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Select, Textarea } from '../ui/Field';

export function TicketRow({
  ticket,
  categories,
  locale,
  canManage,
  onChanged,
}: {
  ticket: Ticket;
  categories: TicketCategory[];
  locale: string;
  canManage: boolean;
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const { data: comments, reload: reloadComments } = useAsync(() => listTicketComments(ticket.id), [ticket.id]);
  const { data: attachments, reload: reloadAttachments } = useAsync(() => listTicketAttachments(ticket.id), [ticket.id]);
  const { data: employees } = useAsync(() => (canManage ? listEmployees({ pageSize: 100 }) : Promise.resolve(null)), [canManage]);
  const [commentBody, setCommentBody] = useState('');
  const [assignee, setAssignee] = useState('');
  const [busy, setBusy] = useState(false);

  function categoryName(categoryId: string): string {
    return categories.find((c) => c.id === categoryId)?.name ?? categoryId.slice(0, 8);
  }

  async function handleAddComment(e: FormEvent) {
    e.preventDefault();
    if (!commentBody.trim()) return;
    setBusy(true);
    try {
      await addTicketComment(ticket.id, commentBody);
      setCommentBody('');
      reloadComments();
    } catch {
      // Surfaced generically — the comment box simply keeps its content on failure.
    } finally {
      setBusy(false);
    }
  }

  async function handleAssign() {
    if (!assignee) return;
    setBusy(true);
    try {
      await assignTicket(ticket.id, assignee);
      onChanged();
    } catch {
      // no-op — a 403/404 here surfaces nothing further; assignment is a best-effort admin action here.
    } finally {
      setBusy(false);
    }
  }

  async function handleAttach(file: File | null) {
    if (!file) return;
    setBusy(true);
    try {
      await addTicketAttachment(ticket.id, file);
      reloadAttachments();
    } catch {
      // no-op — the file input simply stays as-is on failure.
    } finally {
      setBusy(false);
    }
  }

  async function handleStatusChange(status: TicketStatus) {
    setBusy(true);
    try {
      await updateTicketStatus(ticket.id, status);
      onChanged();
    } catch {
      // no-op
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className="group" data-testid="ticket-row">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-1 py-2.5 text-sm hover:bg-sand-50">
        <span className="text-ink-800">{ticket.subject}</span>
        <span className="text-ink-500">{categoryName(ticket.categoryId)}</span>
        <span className="flex items-center gap-2">
          {ticket.slaBreached && <StatusBadge status="ESCALATED" label={t('helpdesk.admin.slaBreached')} />}
          <StatusBadge status={ticket.priority} label={t(`helpdesk.priority.${ticket.priority}`)} />
          <StatusBadge status={ticket.status} label={t(`helpdesk.status.${ticket.status}`)} />
        </span>
      </summary>
      <div className="space-y-4 border-t border-ink-100 px-1 py-3">
        <p className="text-sm text-ink-600">{ticket.description}</p>

        {canManage && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg bg-sand-50 p-3">
            <Select data-testid="ticket-assign-select" value={assignee} onChange={(e) => setAssignee(e.target.value)} className="w-48">
              <option value="">{t('helpdesk.admin.assign')}</option>
              {(employees?.data ?? [])
                .filter((e) => e.userId)
                .map((e) => (
                  <option key={e.id} value={e.userId!}>
                    {e.firstName} {e.lastName}
                  </option>
                ))}
            </Select>
            <Button size="sm" variant="secondary" loading={busy} disabled={!assignee} onClick={handleAssign} data-testid="assign-ticket-button">
              {t('helpdesk.admin.assign')}
            </Button>
            <Select value={ticket.status} onChange={(e) => handleStatusChange(e.target.value as TicketStatus)} className="w-40">
              {TICKET_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {t(`helpdesk.status.${s}`)}
                </option>
              ))}
            </Select>
          </div>
        )}

        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-400">{t('helpdesk.comments')}</p>
          <ul className="space-y-2">
            {(comments ?? []).map((c) => (
              <li key={c.id} data-testid="ticket-comment-row" className="rounded-lg bg-sand-50 p-2 text-sm">
                <p className="text-ink-700">{c.body}</p>
                <p className="mt-1 text-xs text-ink-400">{formatDateTime(c.createdAt, locale)}</p>
              </li>
            ))}
          </ul>
          <form onSubmit={handleAddComment} className="mt-2 flex gap-2">
            <Textarea
              rows={2}
              value={commentBody}
              onChange={(e) => setCommentBody(e.target.value)}
              placeholder={t('helpdesk.addComment')}
              data-testid="ticket-comment-input"
            />
            <Button type="submit" size="sm" loading={busy} data-testid="add-ticket-comment-button">
              {t('helpdesk.addComment')}
            </Button>
          </form>
        </div>

        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-400">{t('helpdesk.attachments')}</p>
          {attachments && attachments.length > 0 && (
            <ul className="mb-2 space-y-1">
              {attachments.map((a) => (
                <li key={a.id}>
                  <Button variant="ghost" size="sm" onClick={() => downloadTicketAttachment(ticket.id, a.id, a.fileName)}>
                    {a.fileName}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <input
            type="file"
            data-testid="ticket-attachment-input"
            onChange={(e) => handleAttach(e.target.files?.[0] ?? null)}
            className="block text-sm text-ink-600"
          />
        </div>
      </div>
    </details>
  );
}
