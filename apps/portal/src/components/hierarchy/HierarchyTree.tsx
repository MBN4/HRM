'use client';

import { AlertTriangle, ChevronDown, ChevronRight, UserCog } from 'lucide-react';
import { useI18n } from '../../i18n/I18nProvider';
import { primaryRoleLabel, userName, type TreeNode } from '../../lib/hierarchy';
import type { HierarchyUser } from '../../lib/api/users';
import { Badge } from '../ui/Badge';

const ROLE_TONE = { CEO: 'success', ADMIN: 'info', HR: 'warning', MANAGER: 'info', MEMBER: 'neutral' } as const;

function initials(u: HierarchyUser): string {
  const words = userName(u).split(/[\s@._-]+/).filter(Boolean);
  return (words[0]?.[0] ?? '?').concat(words[1]?.[0] ?? '').toUpperCase();
}

/** The concise "Approvals go to: …" line, warning-styled when the chain escalated past someone. */
function ApprovalLine({ user, byId }: { user: HierarchyUser; byId: Map<string, HierarchyUser> }) {
  const { t } = useI18n();
  const { kind, skipped } = user.routing;
  const names = user.approvers.map(userName);
  const shown = names.length > 3 ? `${names.slice(0, 2).join(', ')} ${t('hierarchy.more', { count: names.length - 2 })}` : names.join(', ');
  const escalated = kind === 'ESCALATED_MANAGER_UNAVAILABLE' || kind === 'CEO_ESCALATED';
  const skippedNames = skipped
    .filter((s) => s.why === 'DEACTIVATED' || s.why === 'NOT_FOUND')
    .map((s) => (byId.has(s.userId) ? userName(byId.get(s.userId)!) : (s.email ?? s.userId)))
    .join(', ');

  return (
    <div
      className={`mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs ${escalated || kind === 'NO_APPROVER' ? 'font-medium text-amber-700' : 'text-ink-600'}`}
      data-testid={`hierarchy-approver-${user.email}`}
      data-routing-kind={kind}
    >
      {escalated && <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />}
      {kind === 'NO_APPROVER' ? (
        <span>{t('hierarchy.approvals.none')}</span>
      ) : (
        <span>{kind === 'CEO_TOP_OF_CHAIN' ? t('hierarchy.approvals.ceo', { names: shown }) : t('hierarchy.approvals.goTo', { names: shown })}</span>
      )}
      {escalated && <span>· {t('hierarchy.approvals.escalated', { manager: skippedNames || t('hierarchy.approvals.manager') })}</span>}
      {kind === 'ADMIN_FALLBACK' && <span>· {t('hierarchy.approvals.adminFallback')}</span>}
    </div>
  );
}

export function HierarchyTree({
  roots,
  byId,
  collapsed,
  forceOpen,
  matches,
  canChange,
  onToggle,
  onChangeManager,
}: {
  roots: TreeNode[];
  byId: Map<string, HierarchyUser>;
  collapsed: Set<string>;
  forceOpen: Set<string>;
  matches: Set<string>;
  canChange: boolean;
  onToggle: (id: string) => void;
  onChangeManager: (u: HierarchyUser) => void;
}) {
  const shared = { byId, collapsed, forceOpen, matches, canChange, onToggle, onChangeManager };
  return (
    <ul className="space-y-2" data-testid="hierarchy-tree">
      {roots.map((n) => (
        <Node key={n.user.id} node={n} {...shared} />
      ))}
    </ul>
  );
}

type Shared = Omit<Parameters<typeof HierarchyTree>[0], 'roots'>;

function Node({ node, byId, collapsed, forceOpen, matches, canChange, onToggle, onChangeManager }: Shared & { node: TreeNode }) {
  const { t } = useI18n();
  const u = node.user;
  const name = userName(u);
  const hasKids = node.children.length > 0;
  const open = hasKids && (!collapsed.has(u.id) || forceOpen.has(u.id));
  const disabled = u.status !== 'ACTIVE';
  const roleKey = primaryRoleLabel(u.roles, u.directReportCount);
  const groupId = `hier-kids-${u.id}`;

  return (
    <li>
      <div
        data-testid={`hierarchy-node-${u.email}`}
        data-match={matches.has(u.id) || undefined}
        className={`rounded-xl border px-3 py-3 ${
          disabled ? 'border-dashed border-ink-200 bg-sand-50' : 'border-ink-100 bg-surface shadow-card'
        } ${matches.has(u.id) ? 'ring-2 ring-accent-500' : ''}`}
      >
        <div className="flex flex-wrap items-center gap-3">
          {hasKids ? (
            <button
              type="button"
              onClick={() => onToggle(u.id)}
              aria-expanded={open}
              aria-controls={open ? groupId : undefined}
              aria-label={`${open ? t('hierarchy.collapse') : t('hierarchy.expand')} — ${name}`}
              data-testid={`hierarchy-toggle-${u.email}`}
              className="rounded-md p-1 text-ink-500 hover:bg-ink-100 hover:text-ink-800 focus-visible:ring-2 focus-visible:ring-accent-500"
            >
              {open ? <ChevronDown className="h-4 w-4" aria-hidden /> : <ChevronRight className="h-4 w-4 rtl:rotate-180" aria-hidden />}
            </button>
          ) : (
            <span className="inline-block w-6" aria-hidden />
          )}
          <span
            aria-hidden
            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${disabled ? 'bg-ink-100 text-ink-600' : 'bg-brand-100 text-brand-800'}`}
          >
            {initials(u)}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className={`truncate text-sm font-semibold ${disabled ? 'text-ink-600' : 'text-ink-900'}`}>{name}</span>
              <span title={u.roles.join(', ')} data-testid={`hierarchy-role-${u.email}`} data-role={roleKey}>
                <Badge tone={ROLE_TONE[roleKey]}>{t(`hierarchy.role.${roleKey}`)}</Badge>
              </span>
              {disabled && <Badge tone="neutral">{t('users.status.DISABLED')}</Badge>}
            </div>
            <p className="truncate text-xs text-ink-500">{u.email}</p>
          </div>
          <span className="text-xs text-ink-500" data-testid={`hierarchy-reports-${u.email}`}>
            {t('hierarchy.reports', { count: Math.max(u.directReportCount, node.children.length) })}
          </span>
          {canChange && (
            <button
              type="button"
              onClick={() => onChangeManager(u)}
              title={t('hierarchy.changeManager')}
              aria-label={`${t('hierarchy.changeManager')} — ${u.email}`}
              data-testid={`hierarchy-change-manager-${u.email}`}
              className="rounded-md p-1.5 text-ink-500 hover:bg-ink-100 hover:text-ink-800 focus-visible:ring-2 focus-visible:ring-accent-500"
            >
              <UserCog className="h-4 w-4" aria-hidden />
            </button>
          )}
        </div>
        <div className="ps-[3.25rem]">
          <ApprovalLine user={u} byId={byId} />
        </div>
      </div>
      {open && (
        <ul id={groupId} className="ms-5 mt-2 space-y-2 border-s border-ink-200 ps-4">
          {node.children.map((c) => (
            <Node key={c.user.id} node={c} byId={byId} collapsed={collapsed} forceOpen={forceOpen} matches={matches} canChange={canChange} onToggle={onToggle} onChangeManager={onChangeManager} />
          ))}
        </ul>
      )}
    </li>
  );
}
