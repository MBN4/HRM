'use client';

import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import { Button } from './Button';

/**
 * A read-only value with a one-click copy button — for secrets the user
 * must transcribe elsewhere (e.g. a one-time temporary password). The value
 * is always rendered LTR (`dir="ltr"`) even in an RTL page: passwords/ids
 * are not natural-language text and must not be visually reordered by the
 * bidi algorithm.
 */
export function CopyField({ value, label, copyLabel, copiedLabel, 'data-testid': testId }: {
  value: string;
  label: string;
  copyLabel: string;
  copiedLabel: string;
  'data-testid'?: string;
}) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // Clipboard API unavailable (insecure context / denied): fall back to
      // selecting a temporary textarea so the user still gets a copy.
      const el = document.createElement('textarea');
      el.value = value;
      el.setAttribute('readonly', '');
      el.style.position = 'fixed';
      el.style.opacity = '0';
      document.body.appendChild(el);
      el.select();
      try {
        document.execCommand('copy');
      } catch {
        // Nothing more we can do; the value is still visible to copy by hand.
      }
      document.body.removeChild(el);
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div>
      <p className="mb-1.5 text-sm font-medium text-ink-700">{label}</p>
      <div className="flex items-stretch gap-2">
        <output
          dir="ltr"
          data-testid={testId}
          aria-label={label}
          className="block min-w-0 flex-1 select-all break-all rounded-lg border border-ink-200 bg-sand-100 px-3 py-2.5 text-start font-mono text-sm text-ink-900"
        >
          {value}
        </output>
        <Button variant="secondary" onClick={copy} aria-label={copyLabel} data-testid={testId ? `${testId}-copy` : undefined}>
          {copied ? <Check className="h-4 w-4 text-brand-600" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
          <span aria-live="polite">{copied ? copiedLabel : t('users.temp.copy')}</span>
        </Button>
      </div>
    </div>
  );
}
