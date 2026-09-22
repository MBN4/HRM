'use client';

import { InputHTMLAttributes, forwardRef, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { useI18n } from '../../i18n/I18nProvider';
import { Input } from './Field';

/**
 * A password `Input` with a built-in show/hide toggle — see
 * docs/conventions/frontend-ess-mss.md → "Auth screens: password
 * show/hide". The toggle is a plain button positioned inside the field
 * with Tailwind LOGICAL insets (`end-*`) so it lands on the correct side
 * in both LTR and RTL without any direction-specific code.
 */
export const PasswordInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className = '', ...rest }, ref) => {
    const { t } = useI18n();
    const [visible, setVisible] = useState(false);

    return (
      <div className="relative">
        <Input ref={ref} type={visible ? 'text' : 'password'} className={`pe-10 ${className}`} {...rest} />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? t('auth.password.hide') : t('auth.password.show')}
          aria-pressed={visible}
          className="absolute inset-y-0 end-0 flex w-10 items-center justify-center text-ink-400 hover:text-ink-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 rounded-e-lg"
        >
          {visible ? <EyeOff className="h-4 w-4" aria-hidden /> : <Eye className="h-4 w-4" aria-hidden />}
        </button>
      </div>
    );
  },
);
PasswordInput.displayName = 'PasswordInput';
