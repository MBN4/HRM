import { z } from 'zod';

/** Admin device registration (step 3.3, formalizing the 1.3 biometric seam) — see docs/conventions/integrations.md. */
export const registerBiometricDeviceSchema = z.object({
  deviceId: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
});
export type RegisterBiometricDeviceInput = z.infer<typeof registerBiometricDeviceSchema>;

/** The device's own ingestion payload — `deviceId` travels in the URL path, authenticated via the `X-Device-Secret` header, not in this body. */
export const biometricPunchIngestSchema = z.object({
  employeeCode: z.string().min(1).max(64),
  direction: z.enum(['IN', 'OUT']),
  timestamp: z.coerce.date().optional(),
});
export type BiometricPunchIngestInput = z.infer<typeof biometricPunchIngestSchema>;
