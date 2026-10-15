'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Camera, CheckCircle2, LogIn, LogOut, ShieldAlert, WifiOff } from 'lucide-react';
import { SupportedLocale } from '@hrm/shared';
import { useI18n } from '../../i18n/I18nProvider';
import {
  clearKioskToken,
  clockEmployee,
  fetchKioskInfo,
  getStoredKioskLocale,
  getStoredKioskToken,
  identifyEmployee,
  KioskApiError,
  storeKioskLocale,
  storeKioskToken,
  type ClockResult,
  type DayStatus,
  type IdentifyResult,
  type KioskInfo,
} from '../../lib/kiosk/device';
import { ThemeToggle } from '../layout/ThemeToggle';
import { Wordmark } from '../brand/Wordmark';
import { Button } from '../ui/Button';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { Input, Label } from '../ui/Field';
import { PinPad } from './PinPad';
import { useCamera } from './useCamera';

type Phase = 'loading' | 'setup' | 'idle' | 'identified' | 'working' | 'done' | 'revoked';

const MAX_PIN = 8;
/** After a successful punch the screen returns to the idle state on its own so the next person starts clean. */
const DONE_RESET_SECONDS = 7;

const STATUS_DOT: Record<DayStatus, string> = {
  GREEN: 'bg-primary',
  YELLOW: 'bg-amber-400',
  RED: 'bg-danger',
  NEUTRAL: 'bg-ink-300',
  IN_PROGRESS: 'bg-accent-500',
};

function intlLocale(locale: SupportedLocale): string {
  // Latin digits in Arabic too, so times read the same as the (always Latin) keypad.
  return locale === 'ar' ? 'ar-u-nu-latn' : 'en';
}

/**
 * The kiosk terminal (step 11.1) — a single-purpose, locked-down screen: pair once with a device token, then
 * loop identify → confirm → clock → reset for whoever walks up. It shows nothing but that flow: no navigation,
 * no session, no link to the rest of the portal, and it authenticates ONLY with the device token (see
 * `lib/kiosk/device.ts`). All attendance logic (shift, lateness, status) is the server's — this component only
 * renders what the API returns. See docs/conventions/kiosk.md.
 */
export function KioskScreen() {
  const { t, locale, setLocale } = useI18n();

  const [phase, setPhase] = useState<Phase>('loading');
  const [token, setToken] = useState<string | null>(null);
  const [info, setInfo] = useState<KioskInfo | null>(null);
  const [setupToken, setSetupToken] = useState('');
  const [setupError, setSetupError] = useState<string | null>(null);

  const [employeeCode, setEmployeeCode] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState<KioskApiError | null>(null);
  const [identity, setIdentity] = useState<IdentifyResult | null>(null);
  const [result, setResult] = useState<ClockResult | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [busy, setBusy] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [now, setNow] = useState<Date | null>(null);

  const codeRef = useRef<HTMLInputElement>(null);
  const camera = useCamera(phase === 'identified' && Boolean(identity?.requirePhoto));

  // ---- locale: remembered per device; defaults to the browser's language ----------------------
  useEffect(() => {
    const stored = getStoredKioskLocale();
    const initial =
      stored === 'ar' || stored === 'en'
        ? stored
        : navigator.language?.toLowerCase().startsWith('ar')
          ? 'ar'
          : 'en';
    setLocale(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  function chooseLocale(next: SupportedLocale) {
    setLocale(next);
    storeKioskLocale(next);
  }

  useEffect(() => {
    document.title = info ? `${info.name} · ${t('kiosk.title')}` : t('kiosk.title');
  }, [info, t]);

  // ---- live clock ----------------------------------------------------------------------------
  useEffect(() => {
    setNow(new Date());
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);

  // ---- pairing: a launch link carries the token in the URL fragment --------------------------
  const pair = useCallback(
    async (candidate: string): Promise<boolean> => {
      try {
        const kioskInfo = await fetchKioskInfo(candidate);
        storeKioskToken(candidate);
        setToken(candidate);
        setInfo(kioskInfo);
        setPhase('idle');
        return true;
      } catch (e) {
        const err = e as KioskApiError;
        setSetupError(
          err.status === 401 || err.status === 403
            ? t('kiosk.setup.invalid')
            : err.code === 'NETWORK'
              ? t('kiosk.error.NETWORK')
              : t('kiosk.error.generic'),
        );
        return false;
      }
    },
    [t],
  );

  useEffect(() => {
    (async () => {
      const fromHash = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('token');
      if (fromHash) {
        // Strip the token from the address bar/history straight away.
        window.history.replaceState(null, '', window.location.pathname);
        if (await pair(fromHash)) return;
        setPhase('setup');
        return;
      }
      const stored = getStoredKioskToken();
      if (stored && (await pair(stored))) return;
      if (stored) {
        // Stored token no longer works: it was revoked (or the server is unreachable).
        setToken(stored);
        setPhase('revoked');
        return;
      }
      setPhase('setup');
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- helpers -------------------------------------------------------------------------------
  const timeFmt = useMemo(
    () =>
      new Intl.DateTimeFormat(intlLocale(locale), {
        hour: 'numeric',
        minute: '2-digit',
        timeZone: info?.timezone,
      }),
    [locale, info?.timezone],
  );
  const dateFmt = useMemo(
    () =>
      new Intl.DateTimeFormat(intlLocale(locale), {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        timeZone: info?.timezone,
      }),
    [locale, info?.timezone],
  );
  const fmtTime = (iso: string) => timeFmt.format(new Date(iso));

  function resetToIdle(message?: KioskApiError | null) {
    setIdentity(null);
    setResult(null);
    setEmployeeCode('');
    setPin('');
    setBusy(false);
    setError(message ?? null);
    setPhase('idle');
  }

  /** A 401 that is NOT "wrong credentials" means the device token itself is no longer valid. */
  function handleFailure(e: unknown): KioskApiError {
    const err =
      e instanceof KioskApiError ? e : new KioskApiError(0, 'NETWORK', 'Cannot reach the server.');
    if (err.status === 401 && err.code !== 'KIOSK_INVALID_CREDENTIALS') {
      setPhase('revoked');
    }
    return err;
  }

  // ---- identify ------------------------------------------------------------------------------
  async function submitIdentify() {
    if (!token || busy || !employeeCode.trim() || pin.length < 4) return;
    setBusy(true);
    setError(null);
    try {
      const res = await identifyEmployee(token, employeeCode.trim(), pin);
      setPin('');
      setIdentity(res);
      setSecondsLeft(res.expiresInSeconds);
      setPhase('identified');
    } catch (e) {
      const err = handleFailure(e);
      setPin('');
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  // The identify ticket is short-lived: count down and return to idle when it lapses.
  useEffect(() => {
    if (phase !== 'identified') return;
    const id = window.setInterval(() => {
      setSecondsLeft((s) => {
        if (s <= 1) {
          window.clearInterval(id);
          resetToIdle(new KioskApiError(400, 'KIOSK_TICKET_INVALID', 'expired'));
          return 0;
        }
        return s - 1;
      });
    }, 1000);
    return () => window.clearInterval(id);
  }, [phase]);

  // ---- clock ---------------------------------------------------------------------------------
  async function submitClock(action: 'IN' | 'OUT') {
    if (!token || !identity || busy) return;
    setBusy(true);
    setError(null);
    try {
      let photo: Blob | undefined;
      if (identity.requirePhoto) {
        const blob = await camera.capture();
        if (!blob) {
          setError(new KioskApiError(400, 'KIOSK_PHOTO_REQUIRED', 'photo'));
          setBusy(false);
          return;
        }
        photo = blob;
      }
      setPhase('working');
      const res = await clockEmployee(token, identity.ticket, action, photo);
      setResult(res);
      setSecondsLeft(DONE_RESET_SECONDS);
      setPhase('done');
    } catch (e) {
      const err = handleFailure(e);
      // Back to the identified screen for recoverable punch errors, otherwise start over.
      if (err.code === 'KIOSK_TICKET_INVALID' || err.status === 401 || err.status === 429) {
        resetToIdle(err);
      } else {
        setPhase('identified');
        setError(err);
      }
    } finally {
      setBusy(false);
    }
  }

  // After a punch, reset on a timer so the next person starts from a clean screen.
  useEffect(() => {
    if (phase !== 'done') return;
    const id = window.setInterval(() => {
      setSecondsLeft((s) => {
        if (s <= 1) {
          window.clearInterval(id);
          resetToIdle();
          return 0;
        }
        return s - 1;
      });
    }, 1000);
    return () => window.clearInterval(id);
  }, [phase]);

  // Idle fields wipe themselves if someone walks away mid-entry.
  useEffect(() => {
    if (phase !== 'idle' || (!employeeCode && !pin)) return;
    const id = window.setTimeout(() => {
      setEmployeeCode('');
      setPin('');
    }, 45_000);
    return () => window.clearTimeout(id);
  }, [phase, employeeCode, pin]);

  useEffect(() => {
    if (phase === 'idle') codeRef.current?.focus();
  }, [phase]);

  function unpair() {
    clearKioskToken();
    setToken(null);
    setInfo(null);
    setConfirmReset(false);
    resetToIdle();
    setPhase('setup');
  }

  // ---- render --------------------------------------------------------------------------------
  const errorText = (err: KioskApiError): string => {
    const key = `kiosk.error.${err.code}`;
    const translated = t(key, {
      minutes: String(Math.max(1, Math.ceil((err.retryAfterSeconds ?? 60) / 60))),
    });
    return translated.startsWith('[[') ? t('kiosk.error.generic') : translated;
  };

  const fullName = identity ? `${identity.employee.firstName} ${identity.employee.lastName}` : '';
  const dayStatusLabel = (s: { status: DayStatus; reason: string } | null | undefined) =>
    s ? t(`attendance.reason.${s.reason}`) : null;

  return (
    <div
      className="flex min-h-[100dvh] flex-col bg-sand-50 text-ink-900"
      data-testid="kiosk-screen"
      data-phase={phase}
    >
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-ink-100 px-6 py-4">
        <div className="flex items-center gap-4">
          <Wordmark size="md" />
          {info && (
            <div className="border-s border-ink-200 ps-4">
              <p className="text-base font-semibold" data-testid="kiosk-name">
                {info.name}
              </p>
              {info.branchName && <p className="text-sm text-ink-500">{info.branchName}</p>}
            </div>
          )}
        </div>
        <div className="flex items-center gap-4">
          {now && info && (
            <div className="text-end" aria-hidden>
              <p className="text-3xl font-semibold tabular-nums" data-testid="kiosk-clock">
                {timeFmt.format(now)}
              </p>
              <p className="text-sm text-ink-500">{dateFmt.format(now)}</p>
            </div>
          )}
          <div className="flex items-center gap-2">
            <div
              role="group"
              aria-label={t('kiosk.language')}
              className="inline-flex rounded-lg border border-ink-200 bg-surface p-0.5"
            >
              {(['en', 'ar'] as const).map((l) => (
                <button
                  key={l}
                  type="button"
                  lang={l}
                  aria-pressed={locale === l}
                  onClick={() => chooseLocale(l)}
                  data-testid={`kiosk-lang-${l}`}
                  className={`rounded-md px-3 py-1.5 text-sm font-medium ${locale === l ? 'bg-primary text-white' : 'text-ink-700 hover:bg-ink-100'}`}
                >
                  {l === 'en' ? 'EN' : 'العربية'}
                </button>
              ))}
            </div>
            <ThemeToggle />
          </div>
        </div>
      </header>

      <main className="flex flex-1 items-center justify-center px-4 py-8">
        <div className="w-full max-w-xl">
          {phase === 'loading' && (
            <p
              className="text-center text-lg text-ink-500"
              role="status"
              data-testid="kiosk-loading"
            >
              {t('kiosk.loading')}
            </p>
          )}

          {/* ---------------------------------------------------------------- setup */}
          {phase === 'setup' && (
            <form
              className="auth-card space-y-4"
              data-testid="kiosk-setup"
              onSubmit={async (e) => {
                e.preventDefault();
                setSetupError(null);
                if (!(await pair(setupToken.trim()))) setSetupToken('');
              }}
            >
              <h1 className="text-2xl font-semibold">{t('kiosk.setup.title')}</h1>
              <p className="text-ink-500">{t('kiosk.setup.body')}</p>
              <div>
                <Label htmlFor="kiosk-token">{t('kiosk.setup.tokenLabel')}</Label>
                <Input
                  id="kiosk-token"
                  type="password"
                  dir="ltr"
                  autoComplete="off"
                  value={setupToken}
                  onChange={(e) => setSetupToken(e.target.value)}
                  className="h-14 text-lg"
                  data-testid="kiosk-setup-token"
                />
              </div>
              {setupError && (
                <p
                  role="alert"
                  className="rounded-xl border border-coral-200 bg-coral-50 px-4 py-3 text-coral-700"
                  data-testid="kiosk-setup-error"
                >
                  {setupError}
                </p>
              )}
              <Button
                type="submit"
                className="h-14 w-full text-lg"
                disabled={!setupToken.trim()}
                data-testid="kiosk-setup-submit"
              >
                {t('kiosk.setup.pair')}
              </Button>
            </form>
          )}

          {/* ---------------------------------------------------------------- revoked */}
          {phase === 'revoked' && (
            <div
              className="auth-card space-y-4 text-center"
              role="alert"
              data-testid="kiosk-revoked"
            >
              <ShieldAlert className="mx-auto h-14 w-14 text-coral-600" aria-hidden />
              <h1 className="text-2xl font-semibold">{t('kiosk.revoked.title')}</h1>
              <p className="text-ink-500">{t('kiosk.revoked.body')}</p>
              <Button
                variant="secondary"
                className="h-12"
                onClick={unpair}
                data-testid="kiosk-revoked-reset"
              >
                {t('kiosk.revoked.reset')}
              </Button>
            </div>
          )}

          {/* ---------------------------------------------------------------- idle: code + PIN */}
          {phase === 'idle' && (
            <div className="space-y-5" data-testid="kiosk-idle">
              <div className="text-center">
                <h1 className="text-3xl font-semibold tracking-tight">{t('kiosk.idle.title')}</h1>
                <p className="mt-1 text-ink-500">{t('kiosk.idle.subtitle')}</p>
              </div>

              {error && (
                <p
                  role="alert"
                  className="rounded-xl border border-coral-200 bg-coral-50 px-4 py-3 text-center text-lg text-coral-700"
                  data-testid="kiosk-error"
                  data-code={error.code}
                >
                  {errorText(error)}
                </p>
              )}

              <form
                className="space-y-5"
                onSubmit={(e) => {
                  e.preventDefault();
                  void submitIdentify();
                }}
              >
                <div>
                  <Label htmlFor="kiosk-code">{t('kiosk.field.employeeId')}</Label>
                  <Input
                    id="kiosk-code"
                    ref={codeRef}
                    value={employeeCode}
                    onChange={(e) => setEmployeeCode(e.target.value)}
                    autoComplete="off"
                    autoCapitalize="characters"
                    autoCorrect="off"
                    spellCheck={false}
                    dir="ltr"
                    className="h-16 text-center text-2xl font-semibold tracking-wide"
                    data-testid="kiosk-code"
                  />
                </div>
                <div>
                  <Label htmlFor="kiosk-pin">{t('kiosk.field.pin')}</Label>
                  <Input
                    id="kiosk-pin"
                    type="password"
                    // The on-screen keypad is the input method on a tablet; a physical keyboard still types here.
                    inputMode="none"
                    value={pin}
                    onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, MAX_PIN))}
                    autoComplete="off"
                    dir="ltr"
                    className="h-16 text-center text-3xl tracking-[0.5em]"
                    data-testid="kiosk-pin"
                  />
                </div>
                <PinPad
                  disabled={busy}
                  onDigit={(d) => setPin((p) => (p.length < MAX_PIN ? p + d : p))}
                  onBackspace={() => setPin((p) => p.slice(0, -1))}
                  onClear={() => setPin('')}
                />
                <Button
                  type="submit"
                  className="h-16 w-full text-xl"
                  loading={busy}
                  disabled={!employeeCode.trim() || pin.length < 4}
                  data-testid="kiosk-continue"
                >
                  {t('kiosk.continue')}
                </Button>
              </form>
            </div>
          )}

          {/* ---------------------------------------------------------------- identified: confirm + action */}
          {(phase === 'identified' || phase === 'working') && identity && (
            <div className="auth-card space-y-6 text-center" data-testid="kiosk-identified">
              <div
                aria-hidden
                className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-primary text-3xl font-semibold text-white"
              >
                {(identity.employee.firstName[0] ?? '') + (identity.employee.lastName[0] ?? '')}
              </div>
              <div>
                <h1 className="text-3xl font-semibold" data-testid="kiosk-hello">
                  {t('kiosk.hello', { name: fullName })}
                </h1>
                <p className="mt-2 text-lg text-ink-600" data-testid="kiosk-status-line">
                  {identity.state.openSince
                    ? t('kiosk.status.clockedIn', { time: fmtTime(identity.state.openSince) })
                    : identity.state.lastClockOutAt
                      ? t('kiosk.status.clockedOutAt', {
                          time: fmtTime(identity.state.lastClockOutAt),
                        })
                      : t('kiosk.status.notClockedIn')}
                </p>
                {identity.state.today && (
                  <p
                    className="mt-2 inline-flex items-center gap-2 text-ink-600"
                    data-testid="kiosk-day-status"
                    data-status={identity.state.today.status}
                  >
                    <span
                      className={`h-3 w-3 rounded-full ${STATUS_DOT[identity.state.today.status]}`}
                      aria-hidden
                    />
                    {dayStatusLabel(identity.state.today)}
                  </p>
                )}
              </div>

              {identity.requirePhoto && (
                <div className="mx-auto w-full max-w-xs" data-testid="kiosk-camera">
                  <div className="relative overflow-hidden rounded-2xl border border-ink-200 bg-ink-900">
                    <video
                      ref={camera.videoRef}
                      muted
                      playsInline
                      className="aspect-[4/3] w-full -scale-x-100 object-cover"
                      aria-label={t('kiosk.photo.preview')}
                    />
                  </div>
                  <p
                    className="mt-2 flex items-center justify-center gap-2 text-sm text-ink-500"
                    role="status"
                  >
                    <Camera className="h-4 w-4" aria-hidden />
                    {camera.state === 'denied' ? t('kiosk.photo.denied') : t('kiosk.photo.hint')}
                  </p>
                </div>
              )}

              {error && (
                <p
                  role="alert"
                  className="rounded-xl border border-coral-200 bg-coral-50 px-4 py-3 text-lg text-coral-700"
                  data-testid="kiosk-error"
                  data-code={error.code}
                >
                  {errorText(error)}
                </p>
              )}

              <div className="grid grid-cols-2 gap-4">
                {(['IN', 'OUT'] as const).map((action) => {
                  const suggested = identity.state.suggestedAction === action;
                  const Icon = action === 'IN' ? LogIn : LogOut;
                  return (
                    <Button
                      key={action}
                      variant={suggested ? 'primary' : 'secondary'}
                      className="h-24 flex-col text-2xl"
                      disabled={
                        !suggested ||
                        phase === 'working' ||
                        (identity.requirePhoto && camera.state !== 'ready')
                      }
                      loading={phase === 'working' && suggested}
                      onClick={() => void submitClock(action)}
                      data-testid={action === 'IN' ? 'kiosk-clock-in' : 'kiosk-clock-out'}
                    >
                      <Icon className="h-8 w-8" aria-hidden />
                      {t(action === 'IN' ? 'kiosk.action.in' : 'kiosk.action.out')}
                    </Button>
                  );
                })}
              </div>

              <div className="flex items-center justify-between text-sm text-ink-500">
                <span>{t('kiosk.session.ends', { seconds: String(secondsLeft) })}</span>
                <Button
                  variant="ghost"
                  onClick={() => resetToIdle()}
                  disabled={phase === 'working'}
                  data-testid="kiosk-cancel"
                >
                  {t('kiosk.cancel')}
                </Button>
              </div>
            </div>
          )}

          {/* ---------------------------------------------------------------- done */}
          {phase === 'done' && result && (
            <div
              className="auth-card space-y-5 text-center"
              role="status"
              data-testid="kiosk-done"
              data-action={result.action}
            >
              <CheckCircle2 className="mx-auto h-20 w-20 text-primary" aria-hidden />
              <h1 className="text-3xl font-semibold" data-testid="kiosk-done-title">
                {result.action === 'IN'
                  ? t('kiosk.done.in', { name: result.employee.firstName })
                  : t('kiosk.done.out', { name: result.employee.firstName })}
              </h1>
              <p className="text-xl text-ink-700">
                {result.action === 'IN'
                  ? t('kiosk.done.inAt', { time: fmtTime(result.record.clockInAt) })
                  : t('kiosk.done.outAt', {
                      time: fmtTime(result.record.clockOutAt ?? result.record.clockInAt),
                    })}
              </p>
              {result.action === 'OUT' && result.record.workedMinutes !== null && (
                <p className="text-lg text-ink-600">
                  {t('kiosk.done.worked', {
                    hours: String(Math.floor(result.record.workedMinutes / 60)),
                    minutes: String(result.record.workedMinutes % 60),
                  })}
                </p>
              )}
              {result.state.today && (
                <p
                  className="inline-flex items-center gap-2 text-ink-600"
                  data-testid="kiosk-day-status"
                  data-status={result.state.today.status}
                >
                  <span
                    className={`h-3 w-3 rounded-full ${STATUS_DOT[result.state.today.status]}`}
                    aria-hidden
                  />
                  {dayStatusLabel(result.state.today)}
                </p>
              )}
              <div className="flex items-center justify-between text-sm text-ink-500">
                <span>{t('kiosk.done.next', { seconds: String(secondsLeft) })}</span>
                <Button
                  variant="secondary"
                  onClick={() => resetToIdle()}
                  data-testid="kiosk-done-button"
                >
                  {t('kiosk.done.button')}
                </Button>
              </div>
            </div>
          )}

          {error?.code === 'NETWORK' && phase === 'idle' && (
            <p className="mt-4 flex items-center justify-center gap-2 text-sm text-ink-500">
              <WifiOff className="h-4 w-4" aria-hidden />
              {t('kiosk.error.NETWORK')}
            </p>
          )}
        </div>
      </main>

      <footer className="flex items-center justify-between px-6 py-3 text-xs text-ink-400">
        <span>{t('kiosk.footer')}</span>
        {token && phase !== 'setup' && (
          <button
            type="button"
            className="rounded px-2 py-1 hover:bg-ink-100"
            onClick={() => setConfirmReset(true)}
            data-testid="kiosk-unpair"
          >
            {t('kiosk.unpair')}
          </button>
        )}
      </footer>

      {confirmReset && (
        <ConfirmDialog
          title={t('kiosk.unpair.title')}
          body={t('kiosk.unpair.body')}
          confirmLabel={t('kiosk.unpair.confirm')}
          tone="danger"
          onConfirm={async () => unpair()}
          onClose={() => setConfirmReset(false)}
        />
      )}
    </div>
  );
}
