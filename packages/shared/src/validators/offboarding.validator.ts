import { z } from 'zod';

export const OFFBOARDING_REASONS = ['RESIGNATION', 'TERMINATION'] as const;
export type OffboardingReasonKey = (typeof OFFBOARDING_REASONS)[number];

export const initiateOffboardingSchema = z
  .object({
    employeeId: z.string().uuid(),
    reason: z.enum(OFFBOARDING_REASONS),
    lastWorkingDate: z.coerce.date(),
  })
  .strict();
export type InitiateOffboardingInput = z.infer<typeof initiateOffboardingSchema>;
