'use client';

import { useState } from 'react';
import { Plus } from 'lucide-react';
import { PERMISSIONS } from '@hrm/shared';
import { useI18n } from '../../../i18n/I18nProvider';
import { useAuth } from '../../../lib/auth/AuthContext';
import { useAsync } from '../../../lib/useAsync';
import { listTicketCategories, listTickets } from '../../../lib/api/helpdesk';
import { Card, CardBody, CardHeader, CardTitle } from '../../../components/ui/Card';
import { Button } from '../../../components/ui/Button';
import { Modal } from '../../../components/ui/Modal';
import { Alert } from '../../../components/ui/Alert';
import { EmptyState } from '../../../components/ui/EmptyState';
import { PageSpinner } from '../../../components/ui/Spinner';
import { NewTicketForm } from '../../../components/helpdesk/NewTicketForm';
import { TicketRow } from '../../../components/helpdesk/TicketRow';

export default function HelpdeskPage() {
  const { t, locale } = useI18n();
  const { can } = useAuth();
  const [creating, setCreating] = useState(false);

  const canView = can(PERMISSIONS.HELPDESK_READ);
  const { data: categories } = useAsync(() => (canView ? listTicketCategories() : Promise.resolve([])), [canView]);
  const { data: tickets, loading, reload } = useAsync(() => (canView ? listTickets() : Promise.resolve([])), [canView]);

  if (!canView) {
    return <Alert tone="info">{t('error.forbidden')}</Alert>;
  }

  return (
    <div className="max-w-4xl space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-ink-900">{t('helpdesk.title')}</h1>
        <Button data-testid="new-ticket-button" onClick={() => setCreating(true)} disabled={!categories || categories.length === 0}>
          <Plus className="h-4 w-4" aria-hidden />
          {t('helpdesk.newTicket')}
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('helpdesk.myTickets')}</CardTitle>
        </CardHeader>
        <CardBody>
          {loading ? (
            <PageSpinner />
          ) : !tickets || tickets.length === 0 ? (
            <EmptyState title={t('helpdesk.noTickets')} />
          ) : (
            <div className="divide-y divide-ink-100">
              {tickets.map((ticket) => (
                <TicketRow key={ticket.id} ticket={ticket} categories={categories ?? []} locale={locale} canManage={false} onChanged={reload} />
              ))}
            </div>
          )}
        </CardBody>
      </Card>

      {creating && (
        <Modal title={t('helpdesk.newTicket')} onClose={() => setCreating(false)}>
          <NewTicketForm
            categories={categories ?? []}
            onCancel={() => setCreating(false)}
            onSubmitted={() => {
              setCreating(false);
              reload();
            }}
          />
        </Modal>
      )}
    </div>
  );
}
