import { z } from 'zod';

/**
 * Kiosk mode (step 11.1) — a shared attendance terminal. See docs/conventions/kiosk.md.
 */

/** PIN shape: digits only, 4–8 long. Admin-issued PINs are 6 digits (see KioskPinService). */
export const KIOSK_PIN_MIN_LENGTH = 4;
export const KIOSK_PIN_MAX_LENGTH = 8;
export const KIOSK_ISSUED_PIN_LENGTH = 6;
/** The header a kiosk device presents its token in — distinct from `Authorization: Bearer` and `X-Api-Key`. */
export const KIOSK_TOKEN_HEADER = 'x-kiosk-token';

export const registerKioskSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    branchId: z.string().uuid(),
    requirePhoto: z.boolean().default(false),
    biometricEnabled: z.boolean().default(false),
  })
  .strict();
export type RegisterKioskInput = z.infer<typeof registerKioskSchema>;

/** The branch is fixed at registration (a device's physical location); only labels/options are editable. */
export const updateKioskSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    requirePhoto: z.boolean().optional(),
    biometricEnabled: z.boolean().optional(),
  })
  .strict();
export type UpdateKioskInput = z.infer<typeof updateKioskSchema>;

export const kioskIdentifySchema = z
  .object({
    employeeCode: z.string().trim().min(1).max(64),
    pin: z
      .string()
      .regex(
        new RegExp(`^\\d{${KIOSK_PIN_MIN_LENGTH},${KIOSK_PIN_MAX_LENGTH}}$`),
        'PIN must be 4–8 digits.',
      ),
  })
  .strict();
export type KioskIdentifyInput = z.infer<typeof kioskIdentifySchema>;

export const KIOSK_ACTIONS = ['IN', 'OUT'] as const;
export type KioskAction = (typeof KIOSK_ACTIONS)[number];

/** Multipart text fields (an optional `photo` file rides alongside) — hence plain strings. */
export const kioskClockSchema = z
  .object({
    ticket: z.string().min(20).max(2000),
    action: z.enum(KIOSK_ACTIONS),
  })
  .strict();
export type KioskClockInput = z.infer<typeof kioskClockSchema>;

export const kioskBiometricIdentifySchema = z
  .object({ employeeCode: z.string().trim().min(1).max(64) })
  .strict();
export type KioskBiometricIdentifyInput = z.infer<typeof kioskBiometricIdentifySchema>;

export const listKioskPinsQuerySchema = z
  .object({
    branchId: z.string().uuid().optional(),
    search: z.string().trim().max(80).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100),
  })
  .strict();
export type ListKioskPinsQuery = z.infer<typeof listKioskPinsQuerySchema>;
