import { z } from 'zod';

// Deliberately not tightened beyond "8+ chars": a real complexity policy is
// tenant/country-pack configurable territory (see /CLAUDE.md 0.5), not a
// hardcoded rule here.
const passwordSchema = z.string().min(8, 'password must be at least 8 characters');

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});
export type RefreshInput = z.infer<typeof refreshSchema>;

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: passwordSchema,
});
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

export const requestPasswordResetSchema = z.object({
  email: z.string().email(),
});
export type RequestPasswordResetInput = z.infer<typeof requestPasswordResetSchema>;

export const resetPasswordSchema = z.object({
  token: z.string().min(1),
  newPassword: passwordSchema,
});
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

/**
 * Registers/clears the caller's own push-notification device token (step
 * 1.4, mobile ESS) — `null` deregisters (e.g. on logout), matching
 * `User.pushToken`'s own nullable "no device registered" semantics.
 */
export const setPushTokenSchema = z.object({
  pushToken: z.string().min(1).max(512).nullable(),
});
export type SetPushTokenInput = z.infer<typeof setPushTokenSchema>;

// --- Optional tenant-user MFA (step 6.2) — see docs/conventions/security-hardening.md.
// Same shape as the platform admin schemas in platform.validator.ts, applied
// to the tenant identity space instead.

const totpCodeSchema = z.string().regex(/^\d{6}$/, 'code must be a 6-digit TOTP code');

export const mfaEnrollConfirmSchema = z.object({
  code: totpCodeSchema,
});
export type MfaEnrollConfirmInput = z.infer<typeof mfaEnrollConfirmSchema>;

export const mfaDisableSchema = z.object({
  password: z.string().min(1),
  /** Either a 6-digit TOTP code or a one-time recovery code — same acceptance as platform's own MFA verify. */
  code: z.string().min(6),
});
export type MfaDisableInput = z.infer<typeof mfaDisableSchema>;

export const mfaVerifySchema = z.object({
  challengeToken: z.string().min(1),
  /** Either a 6-digit TOTP code or a one-time recovery code. */
  code: z.string().min(6),
});
export type MfaVerifyInput = z.infer<typeof mfaVerifySchema>;
