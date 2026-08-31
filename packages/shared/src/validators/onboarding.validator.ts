import { z } from 'zod';
import { createEmployeeSchema } from './employee.validator';

/**
 * The candidate -> Employee CONVERSION body — see
 * docs/conventions/recruitment-lifecycle.md. Deliberately built by
 * `.omit()`ing from the REAL, UNMODIFIED 1.1 `createEmployeeSchema` rather
 * than redefining an equivalent shape by hand: `statutoryFields`/
 * `bankDetails`/`compensation`/`dependents`/`emergencyContacts`/
 * `customFields` must stay byte-for-byte the same schema `EmployeeService.create`
 * already validates against, so there is no way for this module's
 * candidate-conversion body to drift from what a direct `POST /employees`
 * call accepts. Identity fields (`firstName`/`lastName`/`personalEmail`/
 * `phone`/`dateOfBirth`/`gender`) are omitted because `OnboardingService`
 * sources them from the already-collected `Candidate` row, never asks for
 * them again; `branchId`/`employmentType`/`status`/`userId` are omitted
 * because they're fixed by the already-`ACCEPTED` `Offer` (branch/
 * employment type) or this module's own lifecycle (`status` is always
 * created `ACTIVE`; `userId` linking is a separate, later concern). Every
 * OTHER field this schema still requires — most importantly
 * `statutoryFields`, since the whole point of this step is to enforce the
 * new hire's branch country pack's required fields — is validated
 * EXACTLY as `POST /employees` would validate it, by the SAME
 * `EmployeeService.create` call.
 */
export const completeOnboardingSchema = createEmployeeSchema
  .omit({
    userId: true,
    firstName: true,
    lastName: true,
    personalEmail: true,
    phone: true,
    dateOfBirth: true,
    gender: true,
    branchId: true,
    employmentType: true,
    status: true,
    joinDate: true,
  })
  .extend({
    /** Defaults to the accepted Offer's `proposedJoinDate` when omitted. */
    joinDate: z.coerce.date().optional(),
  });
export type CompleteOnboardingInput = z.infer<typeof completeOnboardingSchema>;
