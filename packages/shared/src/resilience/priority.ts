/**
 * Request priority classification for load shedding (step 0.10) — see
 * /CLAUDE.md § Conventions → Load shedding. `CRITICAL` (login, health,
 * core reads) is never shed; `LOW` (reports, bulk jobs, exports) is the
 * first to be shed under load; `NORMAL` (the default for any route not
 * explicitly classified) sheds only under more severe pressure than `LOW`
 * does not need to reach today — see `LoadSheddingInterceptor` for the
 * exact thresholds.
 */
export const REQUEST_PRIORITIES = ['CRITICAL', 'NORMAL', 'LOW'] as const;
export type RequestPriority = (typeof REQUEST_PRIORITIES)[number];
export const DEFAULT_REQUEST_PRIORITY: RequestPriority = 'NORMAL';
