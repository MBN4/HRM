/** The `entityType` an attendance correction starts its 0.7 `WorkflowInstance` under — see docs/conventions/attendance.md. */
export const ATTENDANCE_REGULARIZATION_ENTITY_TYPE = 'AttendanceRegularization';

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

/** No DB constraint expresses "unique among rows where status = OPEN" (Prisma has no partial-unique-index DSL) — enforced in AttendanceClockService instead. Human-readable message shared across call sites. */
export const ALREADY_CLOCKED_IN_MESSAGE = 'This employee already has an open clock-in — clock out first.';
