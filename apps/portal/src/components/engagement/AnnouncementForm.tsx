'use client';

import { FormEvent, useState } from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import { useAsync } from '../../lib/useAsync';
import { ApiError } from '../../lib/api/client';
import { createFeedPost } from '../../lib/api/engagement';
import { listBranches } from '../../lib/api/tenancy';
import { getWorkingHoursTargets } from '../../lib/api/working-hours';
import { Alert } from '../ui/Alert';
import { Button } from '../ui/Button';
import { Input, Label, Select, Textarea } from '../ui/Field';

type Scope = 'ORG' | 'BRANCH' | 'DEPARTMENT';

/** Admin composer for a company/branch/department announcement on the feed. */
export function AnnouncementForm({ onPosted, onCancel }: { onPosted: () => void; onCancel: () => void }) {
  const { t } = useI18n();
  const { data: branches } = useAsync(() => listBranches().catch(() => []), []);
  const { data: targets } = useAsync(() => getWorkingHoursTargets().catch(() => null), []);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [scopeType, setScopeType] = useState<Scope>('ORG');
  const [scopeId, setScopeId] = useState('');
  const [pinned, setPinned] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const scopeOptions = scopeType === 'BRANCH' ? (branches ?? []).map((b) => ({ id: b.id, name: b.name })) : (targets?.departments ?? []).map((d) => ({ id: d.id, name: `${d.name} (${d.branchName})` }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await createFeedPost({
        type: 'ANNOUNCEMENT',
        title: title.trim() || undefined,
        body,
        scopeType,
        scopeId: scopeType === 'ORG' ? undefined : scopeId,
        pinned,
      });
      onPosted();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('error.generic'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div>
        <Label htmlFor="feed-post-title">
          {t('feed.compose.titleLabel')} ({t('common.optional')})
        </Label>
        <Input id="feed-post-title" maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div>
        <Label htmlFor="feed-post-body">{t('feed.compose.body')}</Label>
        <Textarea id="feed-post-body" rows={4} maxLength={5000} value={body} onChange={(e) => setBody(e.target.value)} required />
      </div>
      <div>
        <Label htmlFor="feed-post-scope">{t('feed.compose.audience')}</Label>
        <Select
          id="feed-post-scope"
          value={scopeType}
          onChange={(e) => {
            setScopeType(e.target.value as Scope);
            setScopeId('');
          }}
        >
          <option value="ORG">{t('feed.compose.scope.ORG')}</option>
          <option value="BRANCH">{t('feed.compose.scope.BRANCH')}</option>
          <option value="DEPARTMENT">{t('feed.compose.scope.DEPARTMENT')}</option>
        </Select>
      </div>
      {scopeType !== 'ORG' && (
        <div>
          <Label htmlFor="feed-post-scope-id">{scopeType === 'BRANCH' ? t('common.branch') : t('feed.compose.department')}</Label>
          <Select id="feed-post-scope-id" value={scopeId} onChange={(e) => setScopeId(e.target.value)} required placeholder={t('feed.compose.choose')}>
            <option value="">{t('feed.compose.choose')}</option>
            {scopeOptions.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </Select>
        </div>
      )}
      <label className="flex items-center gap-2 text-sm text-ink-800">
        <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} />
        {t('feed.compose.pin')}
      </label>
      {error && <Alert tone="error">{error}</Alert>}
      <div className="flex justify-end gap-2 border-t border-ink-100 pt-4">
        <Button type="button" variant="secondary" onClick={onCancel}>
          {t('action.cancel')}
        </Button>
        <Button type="submit" loading={submitting} data-testid="submit-announcement-button">
          {t('feed.compose.publish')}
        </Button>
      </div>
    </form>
  );
}
