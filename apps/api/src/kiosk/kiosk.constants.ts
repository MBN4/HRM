/** Wrong-PIN attempts allowed per EMPLOYEE before that employee's kiosk PIN is locked (anywhere, on any kiosk). */
export const PIN_MAX_FAILURES = 5;
export const PIN_LOCK_SECONDS = 15 * 60;

/** Failed identify attempts allowed per KIOSK DEVICE per window — caps password-spraying across many employee codes from one terminal. */
export const KIOSK_MAX_FAILURES_PER_WINDOW = 20;
export const KIOSK_FAILURE_WINDOW_SECONDS = 10 * 60;

/** Identify attempts per kiosk per minute, successful or not — an upper bound on how fast anything can be tried. */
export const KIOSK_IDENTIFY_PER_MINUTE = 30;

/** How long an identify "ticket" (the proof that this device just verified this employee) stays valid. */
export const TICKET_TTL_SECONDS = 60;

/** A kiosk that has called in within this window is shown as online in the admin list. */
export const KIOSK_ONLINE_WINDOW_MS = 5 * 60 * 1000;

export const MAX_KIOSK_PHOTO_BYTES = 5 * 1024 * 1024;
export const KIOSK_PHOTO_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

/** Stable machine-readable error codes the kiosk screen maps to localized messages. */
export const KIOSK_ERROR = {
  INVALID_CREDENTIALS: 'KIOSK_INVALID_CREDENTIALS',
  LOCKED: 'KIOSK_LOCKED',
  TICKET_INVALID: 'KIOSK_TICKET_INVALID',
  ALREADY_CLOCKED_IN: 'KIOSK_ALREADY_CLOCKED_IN',
  NOT_CLOCKED_IN: 'KIOSK_NOT_CLOCKED_IN',
  PHOTO_REQUIRED: 'KIOSK_PHOTO_REQUIRED',
  PHOTO_INVALID: 'KIOSK_PHOTO_INVALID',
  BIOMETRIC_DISABLED: 'KIOSK_BIOMETRIC_DISABLED',
} as const;
