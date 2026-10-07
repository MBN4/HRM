'use client';

import { useMemo } from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import { useAsync } from '../../lib/useAsync';
import { descendantIds, primaryRoleLabel, userName } from '../../lib/hierarchy';
import { getHierarchy, type HierarchyUser } from '../../lib/api/users';
import { Label } from '../ui/Field';
import { Select } from '../ui/Select';

/**
 * "Reports to" picker (step 7.2) — a searchable Select over ACTIVE users.
 * Excludes the user themself and (client-side loop prevention) everyone
 * below them; the server re-validates regardless and its message is shown
 * by the caller. `items` may be passed to avoid a second fetch.
 */
export function ManagerSelect({
  id,
  value,
  onChange,
  excludeUserId,
  items,
  label,
  disabled,
}: {
  id: string;
  /** Selected manager's user id, or null for "no manager". */
  value: string | null;
  onChange: (managerId: string | null) => void;
  /** The user whose manager is being chosen (omit when creating a new user). */
  excludeUserId?: string;
  items?: HierarchyUser[];
  label?: string;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const { data } = useAsync(() => (items ? Promise.resolve({ items }) : getHierarchy()), [items]);
  const all = items ?? data?.items;

  const options = useMemo(() => {
    if (!all) return [];
    const blocked = excludeUserId ? descendantIds(all, excludeUserId) : new Set<string>();
    return all.filter((u) => u.id !== excludeUserId && !blocked.has(u.id) && (u.status === 'ACTIVE' || u.id === value));
  }, [all, excludeUserId, value]);

  return (
    <div>
      <Label htmlFor={id}>{label ?? t('manager.label')}</Label>
      <Select
        id={id}
        searchable
        disabled={disabled || !all}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value || null)}
        data-testid="manager-select"
      >
        <option value="">{t('manager.none')}</option>
        {options.map((u) => (
          <option key={u.id} value={u.id}>
            {userName(u)} — {u.email} ({t(`hierarchy.role.${primaryRoleLabel(u.roles, u.directReportCount)}`)})
            {u.status !== 'ACTIVE' ? ` · ${t('users.status.DISABLED')}` : ''}
          </option>
        ))}
      </Select>
    </div>
  );
}
