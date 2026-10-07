'use client';

import { useMemo, useState } from 'react';
import { ChevronsDownUp, ChevronsUpDown, Network, Search } from 'lucide-react';
import { PERMISSIONS } from '@hrm/shared';
import { useI18n } from '../../../i18n/I18nProvider';
import { useAuth } from '../../../lib/auth/AuthContext';
import { useAsync } from '../../../lib/useAsync';
import { getHierarchy, type HierarchyUser } from '../../../lib/api/users';
import { ancestorsOfMatches, branchIds, buildTree, userName } from '../../../lib/hierarchy';
import { Card, CardBody } from '../../../components/ui/Card';
import { Button } from '../../../components/ui/Button';
import { Badge } from '../../../components/ui/Badge';
import { Input } from '../../../components/ui/Field';
import { Modal } from '../../../components/ui/Modal';
import { Alert } from '../../../components/ui/Alert';
import { EmptyState } from '../../../components/ui/EmptyState';
import { PageSpinner } from '../../../components/ui/Spinner';
import { HierarchyTree } from '../../../components/hierarchy/HierarchyTree';
import { ChangeManagerForm } from '../../../components/users/ChangeManagerForm';

/**
 * Reporting hierarchy (step 7.2) — a collapsible org tree built client-side
 * from `User.managerId`, showing for every person who CURRENTLY approves
 * their requests (and a warning when the chain escalated past an unavailable
 * manager). Distinct from `/org-chart` (the Employee-record chart). Gated on
 * `user.manage`; the API 403s regardless.
 */
export default function HierarchyPage() {
  const { t } = useI18n();
  const { can } = useAuth();
  const canManage = can(PERMISSIONS.USER_MANAGE);

  const { data, loading, error, reload } = useAsync(() => (canManage ? getHierarchy() : Promise.resolve(null)), [canManage]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<HierarchyUser | null>(null);

  const items = data?.items;
  const roots = useMemo(() => buildTree(items ?? []), [items]);
  const allBranchIds = useMemo(() => branchIds(roots), [roots]);
  // "Open" = at least one branch is currently expanded -> the next click collapses everything; otherwise it expands everything.
  const anyOpen = allBranchIds.some((id) => !collapsed.has(id));
  const byId = useMemo(() => new Map((items ?? []).map((u) => [u.id, u])), [items]);

  const term = search.trim().toLowerCase();
  const { matches, ancestors } = useMemo(
    () =>
      term
        ? ancestorsOfMatches(roots, (u) => userName(u).toLowerCase().includes(term) || u.email.toLowerCase().includes(term))
        : { matches: new Set<string>(), ancestors: new Set<string>() },
    [roots, term],
  );

  if (!canManage) return <Alert tone="info">{t('users.noAccess')}</Alert>;

  function toggle(id: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h1 className="page-title">{t('hierarchy.title')}</h1>
        <p className="mt-1 text-sm text-ink-500">{t('hierarchy.subtitle')}</p>
      </div>

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-ink-100 px-5 py-4">
          <div className="relative">
            <Search className="pointer-events-none absolute inset-y-0 start-3 my-auto h-4 w-4 text-ink-400" aria-hidden />
            <Input
              type="search"
              aria-label={t('hierarchy.search')}
              placeholder={t('hierarchy.search')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="ps-9 sm:w-72"
              data-testid="hierarchy-search"
            />
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setCollapsed(anyOpen ? new Set(allBranchIds) : new Set())}
            aria-label={anyOpen ? t('hierarchy.collapseAll') : t('hierarchy.expandAll')}
            data-testid="hierarchy-toggle-all"
            data-state={anyOpen ? 'expanded' : 'collapsed'}
          >
            {/* One dynamic control: the arrow and label always describe what the NEXT click does. */}
            {anyOpen ? <ChevronsDownUp className="h-4 w-4" aria-hidden /> : <ChevronsUpDown className="h-4 w-4" aria-hidden />}
            {anyOpen ? t('hierarchy.collapseAll') : t('hierarchy.expandAll')}
          </Button>
        </div>
        <CardBody className="space-y-4">
          {term && (
            <p className="text-xs text-ink-500" role="status" data-testid="hierarchy-match-count">
              {t('hierarchy.matches', { count: matches.size })}
            </p>
          )}
          {error && <Alert tone="error">{error}</Alert>}
          {loading && !data ? (
            <PageSpinner />
          ) : roots.length === 0 ? (
            <EmptyState icon={Network} title={t('hierarchy.empty')} />
          ) : (
            <HierarchyTree
              roots={roots}
              byId={byId}
              collapsed={collapsed}
              forceOpen={ancestors}
              matches={matches}
              canChange
              onToggle={toggle}
              onChangeManager={setEditing}
            />
          )}
          <Legend />
        </CardBody>
      </Card>

      {editing && (
        <Modal title={t('hierarchy.changeManagerFor', { name: userName(editing) })} onClose={() => setEditing(null)}>
          <ChangeManagerForm
            userId={editing.id}
            currentManagerId={editing.managerId}
            items={items}
            onCancel={() => setEditing(null)}
            onSaved={() => {
              setEditing(null);
              reload();
            }}
          />
        </Modal>
      )}
    </div>
  );
}

function Legend() {
  const { t } = useI18n();
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-ink-100 pt-4 text-xs text-ink-600" data-testid="hierarchy-legend">
      <span className="font-semibold text-ink-700">{t('hierarchy.legend')}</span>
      <span className="inline-flex items-center gap-1.5"><Badge tone="success">{t('hierarchy.role.CEO')}</Badge>{t('hierarchy.legend.ceo')}</span>
      <span className="inline-flex items-center gap-1.5"><Badge tone="warning">{t('hierarchy.role.HR')}</Badge>{t('hierarchy.legend.hr')}</span>
      <span className="inline-flex items-center gap-1.5"><Badge tone="info">{t('hierarchy.role.MANAGER')}</Badge>{t('hierarchy.legend.manager')}</span>
      <span className="inline-flex items-center gap-1.5"><Badge>{t('hierarchy.role.MEMBER')}</Badge>{t('hierarchy.legend.member')}</span>
      <span className="text-amber-700">{t('hierarchy.legend.escalated')}</span>
      <span>{t('hierarchy.legend.deactivated')}</span>
    </div>
  );
}
