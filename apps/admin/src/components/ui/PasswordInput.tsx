'use client';

import { InputHTMLAttributes, forwardRef, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { Input } from './Field';

/**
 * A password `Input` with a built-in show/hide toggle — see
 * docs/conventions/vendor-console.md → "Auth screen: password show/hide".
 * Copy is plain inline English (like the rest of `apps/admin`'s login
 * page — no `UI_MESSAGES` catalog here, see that doc's note on why). The
 * toggle uses Tailwind LOGICAL insets (`end-*`) so it lands correctly in
 * both LTR and RTL.
 */
export const PasswordInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className = '', ...rest }, ref) => {
    const [visible, setVisible] = useState(false);

    return (
      <div className="relative">
        <Input ref={ref} type={visible ? 'text' : 'password'} className={`pe-10 ${className}`} {...rest} />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? 'Hide password' : 'Show password'}
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
