'use client';

import { FormEvent, useState } from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import { ApiError } from '../../lib/api/client';
import { createUser, type AssignableRole, type TeamUserWithTempPassword } from '../../lib/api/users';
import type { Branch } from '../../lib/api/types';
import { Alert } from '../ui/Alert';
import { Button } from '../ui/Button';
import { Input, Label } from '../ui/Field';
import { ManagerSelect } from './ManagerSelect';
import { RoleBranchPicker } from './RoleBranchPicker';

export function CreateUserForm({
  roles,
  branches,
  onCancel,
  onCreated,
}: {
  roles: AssignableRole[];
  branches: Branch[];
  onCancel: () => void;
  onCreated: (user: TeamUserWithTempPassword) => void;
}) {
  const { t } = useI18n();
  const [email, setEmail] = useState('');
  const [roleIds, setRoleIds] = useState<string[]>([]);
  const [branchIds, setBranchIds] = useState<string[]>([]);
  const [managerId, setManagerId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (roleIds.length === 0) {
      setError(t('users.create.needRole'));
      return;
    }
    setSubmitting(true);
    try {
      onCreated(await createUser({ email: email.trim(), roleIds, branchIds, ...(managerId ? { managerId } : {}) }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('error.generic'));
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4" data-testid="create-user-form">
      <div>
        <Label htmlFor="new-user-email">{t('users.create.email')}</Label>
        <Input id="new-user-email" type="email" required autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} />
      </div>
      <RoleBranchPicker roles={roles} branches={branches} roleIds={roleIds} branchIds={branchIds} onRoleIds={setRoleIds} onBranchIds={setBranchIds} />
      <ManagerSelect id="new-user-manager" value={managerId} onChange={setManagerId} />
      {error && <Alert tone="error">{error}</Alert>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onCancel}>
          {t('action.cancel')}
        </Button>
        <Button type="submit" loading={submitting} data-testid="create-user-submit">
          {submitting ? t('users.create.submitting') : t('users.create.submit')}
        </Button>
      </div>
    </form>
  );
}
