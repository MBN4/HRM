/** The `entityType` a leave request starts its 0.7 `WorkflowInstance` under — see docs/conventions/leave.md. */
export const LEAVE_REQUEST_ENTITY_TYPE = 'LeaveRequest';

/**
 * Leave types accrued monthly by the scheduled accrual job — see
 * `LeaveAccrualService`. MATERNITY/PATERNITY are granted as a lump
 * entitlement at time of request (checked directly against the resolved
 * Country Pack entitlement, not a slowly-accrued running balance) rather
 * than accrued month by month — a common real-world policy this module
 * follows as a deliberate, documented simplification (no data source in
 * this system defines a per-type accrual cadence).
 */
export const ACCRUED_LEAVE_TYPES = ['ANNUAL', 'SICK'] as const;

/** Simple, documented carry-over policy: up to this many unused ANNUAL days survive a year boundary; every other type resets. No data source defines a real carry-over policy, so this is a deliberate simplification — see docs/conventions/leave.md. */
export const MAX_ANNUAL_CARRY_OVER_DAYS = 5;
