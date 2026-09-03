'use client';

import { FormEvent, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ShieldCheck } from 'lucide-react';
import { usePlatformAuth } from '../../lib/auth/PlatformAuthContext';
import { ApiError } from '../../lib/api/client';
import { Button } from '../../components/ui/Button';
import { Input, Label } from '../../components/ui/Field';
import { Alert } from '../../components/ui/Alert';

type Step =
  | { name: 'credentials' }
  | { name: 'mfa-setup'; enrollmentToken: string; secret: string; otpauthUrl: string }
  | { name: 'mfa-verify'; challengeToken: string }
  | { name: 'recovery-codes'; codes: string[] };

export default function LoginPage() {
  const { me, loading: sessionLoading, loginWithPassword, startMfaEnrollment, confirmMfaEnrollment, verifyMfa } = usePlatformAuth();
  const router = useRouter();

  const [step, setStep] = useState<Step>({ name: 'credentials' });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Deliberately does NOT fire during the 'recovery-codes' step: MFA
    // enrollment already populates `me` (a real session exists) the
    // moment it succeeds, but the codes are shown exactly once and must
    // be acknowledged before moving on — an eager redirect here would
    // wipe that screen out from under the admin the instant enrollment
    // completes. That step's own "Continue to the console" button
    // navigates explicitly once acknowledged.
    if (!sessionLoading && me && step.name !== 'recovery-codes') {
      router.replace('/dashboard');
    }
  }, [sessionLoading, me, step.name, router]);

  function errorMessage(err: unknown): string {
    return err instanceof ApiError ? err.message : 'Something went wrong.';
  }

  async function handleCredentials(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const result = await loginWithPassword(email, password);
      if (result.mfaSetupRequired && result.enrollmentToken) {
        const enrollment = await startMfaEnrollment(result.enrollmentToken);
        setStep({ name: 'mfa-setup', enrollmentToken: result.enrollmentToken, ...enrollment });
      } else if (result.mfaRequired && result.challengeToken) {
        setStep({ name: 'mfa-verify', challengeToken: result.challengeToken });
      } else {
        setError('Unexpected response from the server.');
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleConfirmEnrollment(e: FormEvent) {
    e.preventDefault();
    if (step.name !== 'mfa-setup') return;
    setError(null);
    setSubmitting(true);
    try {
      const { recoveryCodes } = await confirmMfaEnrollment(step.enrollmentToken, code);
      setStep({ name: 'recovery-codes', codes: recoveryCodes });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleVerify(e: FormEvent) {
    e.preventDefault();
    if (step.name !== 'mfa-verify') return;
    setError(null);
    setSubmitting(true);
    try {
      await verifyMfa(step.challengeToken, code);
      router.replace('/dashboard');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-ink-950 via-ink-900 to-brand-950 px-4">
      <div className="w-full max-w-md">
        <div className="mb-8 flex items-center justify-center gap-2">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-500 text-lg font-bold text-white">V</div>
          <span className="text-xl font-semibold text-white">HRM Vendor Console</span>
        </div>
        <div className="rounded-xl2 bg-white p-8 shadow-soft">
          {step.name === 'credentials' && (
            <>
              <h1 className="text-lg font-semibold text-ink-900">Platform admin sign in</h1>
              <p className="mt-1 text-sm text-ink-500">Cross-tenant access — MFA is required for every account.</p>
              <form onSubmit={handleCredentials} className="mt-6 space-y-4">
                <div>
                  <Label htmlFor="email">Email</Label>
                  <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
                </div>
                <div>
                  <Label htmlFor="password">Password</Label>
                  <Input
                    id="password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    autoComplete="current-password"
                  />
                </div>
                {error && <Alert tone="error">{error}</Alert>}
                <Button type="submit" className="w-full" loading={submitting}>
                  Continue
                </Button>
              </form>
            </>
          )}

          {step.name === 'mfa-setup' && (
            <>
              <h1 className="flex items-center gap-2 text-lg font-semibold text-ink-900">
                <ShieldCheck className="h-5 w-5 text-brand-600" aria-hidden />
                Set up two-factor authentication
              </h1>
              <p className="mt-1 text-sm text-ink-500">
                This account has no MFA configured yet — required before you can access the vendor console.
              </p>
              <div className="mt-4 space-y-2 rounded-lg border border-ink-100 bg-sand-50 p-4">
                <p className="text-xs font-medium text-ink-500">1. Add this secret to an authenticator app (Google Authenticator, 1Password, ...)</p>
                <p data-testid="mfa-secret" className="select-all break-all rounded-md bg-white px-3 py-2 font-mono text-sm text-ink-900">
                  {step.secret}
                </p>
                <p className="text-xs text-ink-400">Or import this URL directly: <span className="break-all">{step.otpauthUrl}</span></p>
              </div>
              <form onSubmit={handleConfirmEnrollment} className="mt-4 space-y-4">
                <div>
                  <Label htmlFor="code">2. Enter the 6-digit code it generates</Label>
                  <Input
                    id="code"
                    inputMode="numeric"
                    pattern="[0-9]{6}"
                    maxLength={6}
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    required
                    autoComplete="one-time-code"
                  />
                </div>
                {error && <Alert tone="error">{error}</Alert>}
                <Button type="submit" className="w-full" loading={submitting}>
                  Confirm and finish setup
                </Button>
              </form>
            </>
          )}

          {step.name === 'mfa-verify' && (
            <>
              <h1 className="flex items-center gap-2 text-lg font-semibold text-ink-900">
                <ShieldCheck className="h-5 w-5 text-brand-600" aria-hidden />
                Enter your authentication code
              </h1>
              <p className="mt-1 text-sm text-ink-500">Enter the 6-digit code from your authenticator app, or a recovery code.</p>
              <form onSubmit={handleVerify} className="mt-4 space-y-4">
                <div>
                  <Label htmlFor="verify-code">Code</Label>
                  <Input
                    id="verify-code"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    required
                    autoComplete="one-time-code"
                    placeholder="123456 or xxxx-xxxx-xxxx"
                  />
                </div>
                {error && <Alert tone="error">{error}</Alert>}
                <Button type="submit" className="w-full" loading={submitting}>
                  Verify
                </Button>
              </form>
            </>
          )}

          {step.name === 'recovery-codes' && (
            <RecoveryCodesStep codes={step.codes} onContinue={() => router.replace('/dashboard')} />
          )}
        </div>
      </div>
    </div>
  );
}

function RecoveryCodesStep({ codes, onContinue }: { codes: string[]; onContinue: () => void }) {
  const [acknowledged, setAcknowledged] = useState(false);
  return (
    <>
      <h1 className="text-lg font-semibold text-ink-900">Save your recovery codes</h1>
      <p className="mt-1 text-sm text-ink-500">
        Each code works once, if you ever lose access to your authenticator app. They are shown only this one time.
      </p>
      <div data-testid="recovery-codes" className="mt-4 grid grid-cols-2 gap-2 rounded-lg border border-ink-100 bg-sand-50 p-4 font-mono text-sm text-ink-900">
        {codes.map((c) => (
          <span key={c} className="select-all">
            {c}
          </span>
        ))}
      </div>
      <label className="mt-4 flex items-start gap-2 text-sm text-ink-700">
        <input type="checkbox" className="mt-0.5" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} />
        I have saved these recovery codes somewhere safe.
      </label>
      <Button className="mt-4 w-full" disabled={!acknowledged} onClick={onContinue}>
        Continue to the console
      </Button>
    </>
  );
}
