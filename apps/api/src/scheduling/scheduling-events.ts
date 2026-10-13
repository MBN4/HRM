/**
 * Domain events emitted by shift scheduling (step 8.2) and mapped to notifications in
 * `@hrm/shared`'s `NOTIFICATION_EVENT_TYPES`. Every payload carries the recipient's own
 * `employeeUserId` directly, so the recipient resolver needs no DB query.
 */
export const SCHEDULING_EVENTS = {
  ROSTER_PUBLISHED: 'roster.published',
  ROSTER_CHANGED: 'roster.changed',
  SWAP_REQUESTED: 'shift_swap.requested',
} as const;
