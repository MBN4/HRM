import { z } from 'zod';

/**
 * The Analytics dashboard module's schema — see
 * docs/conventions/analytics-dashboard.md. The dashboard READ route
 * (`GET /analytics/dashboard`) takes plain `@Query` strings, the same
 * "no zod needed for a GET" precedent `AttendanceController`'s
 * `listRecords`/`summaryReport` routes already establish — this file only
 * covers the one route with a real request BODY, the manual rollup trigger.
 */

export const runAnalyticsRollupSchema = z
  .object({
    /** Defaults to "yesterday" (UTC) — the last fully-elapsed day — when omitted, same as the real scheduled orchestrator's own default. */
    date: z.coerce.date().optional(),
  })
  .strict();
export type RunAnalyticsRollupInput = z.infer<typeof runAnalyticsRollupSchema>;
