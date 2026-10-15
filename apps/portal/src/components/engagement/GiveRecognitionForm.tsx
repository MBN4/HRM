'use client';

import { FormEvent, useState } from 'react';
import { MAX_RECOGNITION_RECIPIENTS } from '@hrm/shared';
import { useI18n } from '../../i18n/I18nProvider';
import { useAsync } from '../../lib/useAsync';
import { ApiError } from '../../lib/api/client';
import { getOwnEmployee } from '../../lib/api/employees';
import { giveRecognition } from '../../lib/api/engagement';
import type { RecognitionCategory, RecognitionVisibility } from '../../lib/api/types';
import { Alert } from '../ui/Alert';
import { Button } from '../ui/Button';
import { Label, Select, Textarea } from '../ui/Field';
import { PeoplePicker, type PickedPerson } from './PeoplePicker';

export function GiveRecognitionForm({ categories, onGiven, onCancel }: { categories: RecognitionCategory[]; onGiven: () => void; onCancel: () => void }) {
  const { t } = useI18n();
  const { data: me } = useAsync(() => getOwnEmployee().catch(() => null), []);
  const [recipients, setRecipients] = useState<PickedPerson[]>([]);
  const [categoryId, setCategoryId] = useState(categories[0]?.id ?? '');
  const [message, setMessage] = useState('');
  const [visibility, setVisibility] = useState<RecognitionVisibility>('PUBLIC');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (recipients.length === 0) {
      setError(t('recognition.give.needRecipient'));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await giveRecognition({ recipientEmployeeIds: recipients.map((r) => r.id), categoryId, message, visibility });
      onGiven();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('error.generic'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div>
        <Label htmlFor="recognition-recipients">{t('recognition.give.recipients')}</Label>
        <PeoplePicker
          inputId="recognition-recipients"
          label={t('recognition.give.recipients')}
          value={recipients}
          onChange={setRecipients}
          excludeIds={me ? [me.id] : []}
          max={MAX_RECOGNITION_RECIPIENTS}
        />
      </div>
      <div>
        <Label htmlFor="recognition-category">{t('recognition.give.category')}</Label>
        <Select id="recognition-category" value={categoryId} onChange={(e) => setCategoryId(e.target.value)} required>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} ({t('recognition.points', { count: c.points })})
            </option>
          ))}
        </Select>
      </div>
      <div>
        <Label htmlFor="recognition-message">{t('recognition.give.message')}</Label>
        <Textarea id="recognition-message" rows={4} maxLength={1000} value={message} onChange={(e) => setMessage(e.target.value)} required />
      </div>
      <fieldset>
        <legend className="mb-1.5 text-sm font-medium text-ink-700">{t('recognition.give.visibility')}</legend>
        <div className="space-y-2">
          {(['PUBLIC', 'PRIVATE'] as const).map((v) => (
            <label key={v} className="flex cursor-pointer items-start gap-2 text-sm text-ink-800">
              <input type="radio" name="recognition-visibility" value={v} checked={visibility === v} onChange={() => setVisibility(v)} className="mt-1" data-testid={`visibility-${v}`} />
              <span>
                <span className="font-medium">{t(`recognition.visibility.${v}`)}</span>
                <span className="block text-xs text-ink-500">{t(`recognition.visibility.${v}.help`)}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      {error && <Alert tone="error">{error}</Alert>}

      <div className="flex justify-end gap-2 border-t border-ink-100 pt-4">
        <Button type="button" variant="secondary" onClick={onCancel}>
          {t('action.cancel')}
        </Button>
        <Button type="submit" loading={submitting} data-testid="submit-recognition-button">
          {t('recognition.give.submit')}
        </Button>
      </div>
    </form>
  );
}
