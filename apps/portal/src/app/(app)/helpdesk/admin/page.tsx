'use client';

import { useState } from 'react';
import { Plus } from 'lucide-react';
import { PERMISSIONS } from '@hrm/shared';
import { useI18n } from '../../../../i18n/I18nProvider';
import { useAuth } from '../../../../lib/auth/AuthContext';
import { useAsync } from '../../../../lib/useAsync';
import { listTicketCategories, listTickets } from '../../../../lib/api/helpdesk';
import { Card, CardBody, CardHeader, CardTitle } from '../../../../components/ui/Card';
import { Button } from '../../../../components/ui/Button';
import { Modal } from '../../../../components/ui/Modal';
import { Alert } from '../../../../components/ui/Alert';
import { EmptyState } from '../../../../components/ui/EmptyState';
import { PageSpinner } from '../../../../components/ui/Spinner';
import { TicketCategoryForm } from '../../../../components/helpdesk/TicketCategoryForm';
import { TicketRow } from '../../../../components/helpdesk/TicketRow';

export default function HelpdeskAdminPage() {
  const { t, locale } = useI18n();
  const { can } = useAuth();
  const [addingCategory, setAddingCategory] = useState(false);

  const canManage = can(PERMISSIONS.HELPDESK_MANAGE);
  const { data: categories, reload: reloadCategories } = useAsync(() => (canManage ? listTicketCategories() : Promise.resolve([])), [canManage]);
  const { data: tickets, loading, reload } = useAsync(() => (canManage ? listTickets() : Promise.resolve([])), [canManage]);

  if (!canManage) {
    return <Alert tone="info">{t('error.forbidden')}</Alert>;
  }

  return (
    <div className="max-w-4xl space-y-6">
      <h1 className="text-xl font-semibold text-ink-900">{t('helpdesk.admin.title')}</h1>

      <Card>
        <CardHeader>
          <CardTitle>{t('helpdesk.admin.categories')}</CardTitle>
          <Button size="sm" onClick={() => setAddingCategory(true)}>
            <Plus className="h-4 w-4" aria-hidden />
            {t('helpdesk.admin.newCategory')}
          </Button>
        </CardHeader>
        <CardBody>
          {!categories || categories.length === 0 ? (
            <p className="text-sm text-ink-400">{t('common.noData')}</p>
          ) : (
            <ul className="divide-y divide-ink-100 text-sm">
              {categories.map((c) => (
                <li key={c.id} className="flex items-center justify-between py-2">
                  <span className="text-ink-800">
                    {c.name} <span className="text-ink-400">({c.code})</span>
                  </span>
                  <span className="text-ink-500">{c.defaultSlaMinutes ? `${t('helpdesk.admin.slaMinutes')}: ${c.defaultSlaMinutes}` : '—'}</span>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('helpdesk.admin.queue')}</CardTitle>
        </CardHeader>
        <CardBody>
          {loading ? (
            <PageSpinner />
          ) : !tickets || tickets.length === 0 ? (
            <EmptyState title={t('helpdesk.noTickets')} />
          ) : (
            <div className="divide-y divide-ink-100">
              {tickets.map((ticket) => (
                <TicketRow key={ticket.id} ticket={ticket} categories={categories ?? []} locale={locale} canManage onChanged={reload} />
              ))}
            </div>
          )}
        </CardBody>
      </Card>

      {addingCategory && (
        <Modal title={t('helpdesk.admin.newCategory')} onClose={() => setAddingCategory(false)}>
          <TicketCategoryForm
            onCancel={() => setAddingCategory(false)}
            onSaved={() => {
              setAddingCategory(false);
              reloadCategories();
            }}
          />
        </Modal>
      )}
    </div>
  );
}
