/** The `entityType` a performance appraisal's sign-off `WorkflowInstance` is started with — see docs/conventions/performance.md. */
export const PERFORMANCE_APPRAISAL_ENTITY_TYPE = 'PerformanceAppraisal';

/** Review types the org chart can resolve automatically at enrollment — PEER is always explicit, never auto-resolved. */
export const AUTO_RESOLVED_REVIEW_TYPES = ['SELF', 'MANAGER', 'UPWARD'] as const;
