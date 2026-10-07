'use client';

import { useI18n } from '../../i18n/I18nProvider';
import type { AssignableRole } from '../../lib/api/users';
import type { Branch } from '../../lib/api/types';

function toggle(list: string[], id: string): string[] {
  return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
}

/** Multi-select checkbox groups for roles (disabled when the caller can't grant them) and branch scope — shared by the create and edit dialogs. */
export function RoleBranchPicker({
  roles,
  branches,
  roleIds,
  branchIds,
  onRoleIds,
  onBranchIds,
}: {
  roles: AssignableRole[];
  branches: Branch[];
  roleIds: string[];
  branchIds: string[];
  onRoleIds: (ids: string[]) => void;
  onBranchIds: (ids: string[]) => void;
}) {
  const { t } = useI18n();
  return (
    <>
      <fieldset>
        <legend className="mb-1.5 block text-sm font-medium text-ink-700">{t('users.create.roles')}</legend>
        <div className="grid gap-1.5 sm:grid-cols-2">
          {roles.map((role) => (
            <label
              key={role.id}
              className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm ${
                role.assignable ? 'cursor-pointer border-ink-200 text-ink-800 hover:bg-sand-100' : 'cursor-not-allowed border-ink-100 text-ink-400'
              }`}
            >
              <input
                type="checkbox"
                className="h-4 w-4 accent-brand-600"
                checked={roleIds.includes(role.id)}
                disabled={!role.assignable}
                onChange={() => onRoleIds(toggle(roleIds, role.id))}
                data-testid={`role-option-${role.name}`}
              />
              {role.name}
            </label>
          ))}
        </div>
        <p className="mt-1 text-xs text-ink-400">{t('users.create.rolesHint')}</p>
      </fieldset>

      {branches.length > 0 && (
        <fieldset>
          <legend className="mb-1.5 block text-sm font-medium text-ink-700">{t('users.create.branches')}</legend>
          <div className="grid gap-1.5 sm:grid-cols-2">
            {branches.map((branch) => (
              <label key={branch.id} className="flex cursor-pointer items-center gap-2 rounded-lg border border-ink-200 px-3 py-2 text-sm text-ink-800 hover:bg-sand-100">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-brand-600"
                  checked={branchIds.includes(branch.id)}
                  onChange={() => onBranchIds(toggle(branchIds, branch.id))}
                  data-testid={`branch-option-${branch.name}`}
                />
                {branch.name}
              </label>
            ))}
          </div>
          <p className="mt-1 text-xs text-ink-400">{t('users.create.branchesHint')}</p>
        </fieldset>
      )}
    </>
  );
}
