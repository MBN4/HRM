'use client';

import { KeyRound } from 'lucide-react';
import { useI18n } from '../../i18n/I18nProvider';
import { Alert } from '../ui/Alert';
import { Button } from '../ui/Button';
import { CopyField } from '../ui/CopyField';

/**
 * The show-once confirmation after create / regenerate. The password lives
 * only in this component's props (React state of the page that opened it)
 * and is dropped the moment the dialog closes — it is never put in a URL,
 * localStorage or a toast, and the API never returns it again.
 */
export function TempPasswordPanel({ email, temporaryPassword, onDone }: { email: string; temporaryPassword: string; onDone: () => void }) {
  const { t } = useI18n();
  return (
    <div className="space-y-4" data-testid="temp-password-panel">
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand-50 text-brand-600">
          <KeyRound className="h-5 w-5" aria-hidden />
        </span>
        <p className="text-sm text-ink-700">{t('users.temp.intro', { email })}</p>
      </div>
      <CopyField
        value={temporaryPassword}
        label={t('users.temp.title')}
        copyLabel={t('users.temp.copy')}
        copiedLabel={t('users.temp.copied')}
        data-testid="temp-password-value"
      />
      <Alert tone="info">{t('users.temp.once')}</Alert>
      <p className="text-xs text-ink-500">{t('users.temp.firstSignIn')}</p>
      <div className="flex justify-end">
        <Button onClick={onDone} data-testid="temp-password-done">
          {t('users.temp.done')}
        </Button>
      </div>
    </div>
  );
}
