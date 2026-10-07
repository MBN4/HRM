'use client';

import { FormEvent, useState } from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import { ApiError } from '../../lib/api/client';
import { updateUserAccess, type AssignableRole, type TeamUser } from '../../lib/api/users';
import type { Branch } from '../../lib/api/types';
import { Alert } from '../ui/Alert';
import { Button } from '../ui/Button';
import { RoleBranchPicker } from './RoleBranchPicker';

export function EditAccessForm({
  user,
  roles,
  branches,
  onCancel,
  onSaved,
}: {
  user: TeamUser;
  roles: AssignableRole[];
  branches: Branch[];
  onCancel: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const [roleIds, setRoleIds] = useState(user.roles.map((r) => r.id));
  const [branchIds, setBranchIds] = useState(user.branches.map((b) => b.id));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The server only lets a caller manage users whose permissions they fully
  // cover, so every role the target already holds is assignable here.
  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (roleIds.length === 0) {
      setError(t('users.create.needRole'));
      return;
    }
    setSubmitting(true);
    try {
      await updateUserAccess(user.id, { roleIds, branchIds });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('error.generic'));
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4" data-testid="edit-access-form">
      <RoleBranchPicker roles={roles} branches={branches} roleIds={roleIds} branchIds={branchIds} onRoleIds={setRoleIds} onBranchIds={setBranchIds} />
      {error && <Alert tone="error">{error}</Alert>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onCancel}>
          {t('action.cancel')}
        </Button>
        <Button type="submit" loading={submitting} data-testid="edit-access-submit">
          {submitting ? t('users.edit.submitting') : t('users.edit.submit')}
        </Button>
      </div>
    </form>
  );
}
