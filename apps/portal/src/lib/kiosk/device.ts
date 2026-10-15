import { KIOSK_TOKEN_HEADER } from '@hrm/shared';
import { resolveTenant } from '../tenant';

/**
 * The kiosk SCREEN's own API client (step 11.1). Deliberately separate from `lib/api/client.ts`: a kiosk
 * authenticates with its DEVICE TOKEN only — it must never attach (or refresh, or fall back to) a user session
 * that happens to sit in this browser's storage, and it needs none of the tenant-header machinery (the token
 * itself establishes the tenant). See docs/conventions/kiosk.md.
 */
const TOKEN_KEY = 'mbn.kiosk.token';
const LOCALE_KEY = 'mbn.kiosk.locale';

export interface KioskInfo {
  id: string;
  name: string;
  branchId: string;
  branchName: string | null;
  timezone: string;
  requirePhoto: boolean;
  biometricEnabled: boolean;
}

export type DayStatus = 'GREEN' | 'YELLOW' | 'RED' | 'NEUTRAL' | 'IN_PROGRESS';

export interface KioskEmployeeState {
  openSince: string | null;
  lastClockOutAt: string | null;
  suggestedAction: 'IN' | 'OUT';
  today: {
    status: DayStatus;
    reason: string;
    isLate: boolean;
    minutesLate: number;
    hoursWorked: number;
    expectedStartTime: string;
  } | null;
}

export interface KioskEmployee {
  employeeCode: string;
  firstName: string;
  lastName: string;
}

export interface IdentifyResult {
  ticket: string;
  expiresInSeconds: number;
  requirePhoto: boolean;
  employee: KioskEmployee;
  state: KioskEmployeeState;
}

export interface ClockResult {
  action: 'IN' | 'OUT';
  record: {
    id: string;
    clockInAt: string;
    clockOutAt: string | null;
    workedMinutes: number | null;
    lateMinutes: number;
  };
  employee: KioskEmployee;
  state: KioskEmployeeState;
}

export class KioskApiError extends Error {
  constructor(
    public status: number,
    /** A stable `KIOSK_*` code when the server sent one; `NETWORK` when the server could not be reached. */
    public code: string,
    message: string,
    public retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

export function getStoredKioskToken(): string | null {
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}
export function storeKioskToken(token: string): void {
  try {
    window.localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // Storage unavailable: the kiosk works for this page load only.
  }
}
export function clearKioskToken(): void {
  try {
    window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    // ignore
  }
}
export function getStoredKioskLocale(): string | null {
  try {
    return window.localStorage.getItem(LOCALE_KEY);
  } catch {
    return null;
  }
}
export function storeKioskLocale(locale: string): void {
  try {
    window.localStorage.setItem(LOCALE_KEY, locale);
  } catch {
    // ignore
  }
}

async function call<T>(
  token: string,
  path: string,
  init: { method?: string; json?: unknown; form?: FormData } = {},
): Promise<T> {
  const headers: Record<string, string> = { [KIOSK_TOKEN_HEADER]: token };
  let body: BodyInit | undefined;
  if (init.form) {
    body = init.form;
  } else if (init.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(init.json);
  }
  let res: Response;
  try {
    res = await fetch(
      new URL(
        path.replace(/^\//, ''),
        `${resolveTenant().apiBaseUrl.replace(/\/$/, '')}/`,
      ).toString(),
      {
        method: init.method ?? 'GET',
        headers,
        body,
        cache: 'no-store',
      },
    );
  } catch {
    throw new KioskApiError(0, 'NETWORK', 'Cannot reach the server.');
  }
  const data = (await res.json().catch(() => null)) as {
    code?: string;
    message?: unknown;
    retryAfterSeconds?: number;
  } | null;
  if (!res.ok) {
    const message = typeof data?.message === 'string' ? data.message : 'Request failed.';
    throw new KioskApiError(
      res.status,
      data?.code ?? `HTTP_${res.status}`,
      message,
      data?.retryAfterSeconds,
    );
  }
  return data as T;
}

export const fetchKioskInfo = (token: string) => call<KioskInfo>(token, '/kiosk/me');
export const identifyEmployee = (token: string, employeeCode: string, pin: string) =>
  call<IdentifyResult>(token, '/kiosk/identify', { method: 'POST', json: { employeeCode, pin } });
export function clockEmployee(token: string, ticket: string, action: 'IN' | 'OUT', photo?: Blob) {
  const form = new FormData();
  form.set('ticket', ticket);
  form.set('action', action);
  if (photo) form.set('photo', photo, 'kiosk.jpg');
  return call<ClockResult>(token, '/kiosk/clock', { method: 'POST', form });
}
