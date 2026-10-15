
/** Domain events emitted by engagement (step 10.1), mapped to notifications in `@hrm/shared`. Every payload carries the recipient's own `recipientUserId`, so the recipient resolver needs no DB query. */
export const ENGAGEMENT_EVENTS = {
  RECOGNITION_RECEIVED: 'engagement.recognition_received',
  SURVEY_ASSIGNED: 'engagement.survey_assigned',
} as const;

/** Daily celebrations generation (birthdays / work anniversaries / new joiners) — 06:00 UTC. */
export const CELEBRATIONS_ORCHESTRATOR_CRON = '0 6 * * *';
export const CELEBRATIONS_ORCHESTRATOR_JOB_ID = 'engagement-celebrations-orchestrator';

/** A new joiner is announced for this many days after their join date. */
export const NEW_JOINER_WINDOW_DAYS = 7;

/** Bounds on unbounded-looking reads. */
export const MAX_TEXT_ANSWERS_PER_QUESTION = 200;
export const MAX_AUDIENCE_SIZE = 50_000;

