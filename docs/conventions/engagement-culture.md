# Engagement & culture — recognition, surveys, the social feed

[← Back to CLAUDE.md](../../CLAUDE.md) · [Build log](../BUILD_LOG.md)

Step 10.1 — a **new module that consumes existing systems**; nothing was rebuilt.
Tenancy/RLS ([`tenancy-rls.md`](./tenancy-rls.md)), auth + RBAC
([`auth-rbac.md`](./auth-rbac.md)), the notification hub
([`notifications-queues.md`](./notifications-queues.md)), audit
([`audit-custom-fields.md`](./audit-custom-fields.md)), the scheduled-BullMQ-job
pattern (1.5 / 3.2), 8.2's reporting-chain resolver and the MBN design system
([`design-system.md`](./design-system.md)) are all used as-is. The only edit to
existing code is one additive export (`SchedulingModule` now also exports
`SchedulingScopeService`) and the additive event/recipient/listener wiring the
hub already expects for a new event namespace.

Code: `apps/api/src/engagement/`, schema in `packages/db/prisma/schema.prisma`
(migrations `20261015090000_add_engagement_culture` +
`20261015090100_enable_rls_for_engagement`), validators in
`packages/shared/src/validators/engagement.validator.ts`, UI in `apps/portal`
(`/recognition`, `/feed`, `/surveys`, `/engagement`).

## Permissions (the two new ones)

| Permission          | Seeded to                                                        | Gates                                                                                                                                |
| ------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `recognition.give`  | **every** system role (TENANT_ADMIN, CEO, HR, MANAGER, EMPLOYEE) | Giving recognition, reacting to and commenting on feed posts — the broad "participation" permission.                                 |
| `engagement.manage` | TENANT_ADMIN, CEO (via `ALL_PERMISSIONS`), HR_MANAGER            | Survey authoring/publish/close/results/respondents, recognition categories, admin posts, moderation (remove post/comment), overview. |

Reading the feed, viewing recognition, answering a survey **assigned to you** and
the leaderboard need only authentication — they are inherently self-/tenant-scoped,
the same posture `/notifications` takes. The migration backfills both permissions
for every existing tenant (idempotent); new tenants get them from
`seedSystemRolesAndPermissions`. Like every permission here they are DB rows a
tenant can re-assign (a role without `recognition.give` can still read the feed —
tested with a custom role).

## 1. Recognition

- **Categories are tenant data** (`RecognitionCategory`: name, description,
  `points`, `isActive`; `@@unique([tenantId, name])`). Never deleted — past
  recognitions reference them — only deactivated, which stops _new_ use.
- **Giving** (`POST /recognition`) is one transaction: a `Recognition` (giver,
  category, message, `PUBLIC|PRIVATE`), one `RecognitionRecipient` per person
  (the points **snapshot** + denormalized `categoryId`/`occurredAt` so the
  leaderboard is a single indexed group-by), an atomic increment of each
  recipient's `RecognitionBalance` (the running points tally), and — when
  PUBLIC — the mirrored `FeedPost`. Rules: ≤10 recipients; the giver needs an
  `Employee` profile; no self-recognition; recipients must be ACTIVE and inside
  the caller's **branch scope** (an out-of-scope/foreign/inactive id is one
  indistinguishable `404`).
- **Notification** via the 0.8 hub: the service emits
  `engagement.recognition_received` (payload carries `recipientUserId`, so the
  resolver needs no query); `IN_APP` by default; en/ar templates seeded.
- **Points are deliberately simple** — a running count. **No redemption store in
  v1 (fast-follow).** Moderation reverses the points (below).
- **Privacy of PRIVATE recognition.** Visible only to its giver and recipients.
  It is therefore excluded from the leaderboard and from anyone else's view of a
  profile; the all-time `RecognitionBalance` (which includes private points) is
  shown only to its owner. (Admins see only aggregate _counts_ of private
  recognition in the overview, never identities/messages.)
- **Leaderboard / profile**: `GET /recognition/leaderboard?from&to&categoryId&limit`
  (default last 30 days, PUBLIC only, branch-scoped, capped) and
  `GET /recognition/profile/:employeeId` (own profile = everything; someone
  else's = public only; out-of-branch = 404).

## 2. Surveys

Lifecycle `DRAFT → OPEN → CLOSED`. A DRAFT is edited by full replacement
(`PUT`); **questions freeze at publish** (answers/tallies key on question ids).
Question types: `RATING` (inclusive scale, 0/1…≤10), `SINGLE_CHOICE`,
`MULTI_CHOICE`, `TEXT`. A survey is answerable only while `OPEN` and inside
`[opensAt, closesAt)` — the _effective_ state is computed on read
(`effectiveSurveyState`), so a lapsed `closesAt` closes it with no sweeper job.

**Audience** (`ORG | BRANCH | DEPARTMENT | TEAM`) is resolved **once, at
publish**, into `SurveyAssignment` rows (who can answer; the response-rate
denominator). BRANCH/DEPARTMENT by id (a department includes its
sub-departments); TEAM = the whole reporting chain of each named manager
(`SchedulingScopeService.reportingChainEmployees`, the 8.2 definition of a
manager's team). Only ACTIVE employees **with a login** can answer. Joining a
team later does _not_ add you to an already-open survey — the denominator must
not drift while it runs. A branch-restricted admin cannot publish org-wide or
to people outside their branches (`403`). Assignees are notified through the hub
(`engagement.survey_assigned`, IN_APP + EMAIL).

### The anonymity guarantee (server-enforced, DB-enforced, tested)

When `anonymous = true`, **nothing stored about a response identifies the
respondent** — not by id, not by timestamp, not by joining tables:

1. `SurveyResponse.respondentUserId` is **`NULL`** (a plain column — no FK — so
   nothing about the link outlives the user row either), and `submittedOn` is a
   **`DATE`**, not a timestamp.
2. `SurveyAnswer`/`SurveyTally` carry no user/employee column at all (a test
   asserts the only user-ish column across those three tables is the nullable
   one above).
3. Who-has-answered lives only in `SurveyAssignment` (`status` + a **date**) — it
   has no response id and no time-of-day, so it cannot be lined up with a
   response. It is claimed atomically (`UPDATE … WHERE status = 'PENDING'`), so
   a concurrent double-submit records exactly one response (tested).
4. The submit route is **deliberately not `@AuditLog`ged** (the audit interceptor
   would write the actor's user id beside the request/response — exactly the link
   this feature exists to not keep) and emits **no domain event** carrying the
   respondent. A test proves no `audit_log` row ties any respondent to the survey
   or to the free-text they wrote.
5. **The application DB role is `SELECT + INSERT` only on `survey_responses` /
   `survey_answers`** (migration `…090100`; no `UPDATE`/`DELETE`) — a bug or an
   attacker holding `hrm_app` credentials cannot re-attribute or rewrite a stored
   response. Tested: `UPDATE`/`DELETE` as the app role → `permission denied`.
6. **Results never contain identity**, even for identified surveys; no
   per-branch/department breakdown is offered (slicing re-identifies small
   groups); free-text is returned without timestamps in `id` (random UUID)
   order. For an anonymous survey **every aggregate is withheld until
   `ANONYMITY_MIN_RESPONSES` (3) responses exist** (`suppressed: true`; the
   response rate stays visible). `GET /surveys/:id/respondents` is `403` for an
   anonymous survey — a pending list would re-identify by elimination.

The proof (`engagement.e2e-spec.ts` › "ANONYMOUS surveys") reads the **raw
tables with the owner client** — no API in the way — and asserts that no user
id, employee id, email or name appears anywhere in the response-side rows, that
`respondent_user_id` is NULL, that the timestamps carry no time component, that
audit has no linking row, and (the contrast case) that a _non-anonymous_ survey
**does** store the link, so the guarantee is real rather than an artifact of the
test.

**Honest residual risks** (stated, not hidden): (a) a DBA/superuser with raw
database access could still reason about physical row order/`xmin`/WAL — this
guards the application and the app DB role, not a malicious database owner;
(b) free-text can identify its author by content ("as the only
Doha-based PM, …") — no server can prevent it, and the UI does not yet warn respondents (fast-follow);
(c) in a very small audience even the ≥3 threshold is thin — the threshold is a
constant (`ANONYMITY_MIN_RESPONSES`), raise it for small populations; (d) error
tracking (Sentry seam, Noop by default) could capture a failing request body —
keep survey routes out of any request-body capture if a real Sentry is bound.

### Aggregation / scale

Results never scan answers. `publish` pre-creates a `SurveyTally` counter per
(survey, question, bucket) — a rating value or a choice option id — and submit
does atomic `increment`s on them plus `Survey.responseCount`. A results page reads
those counters (O(questions × options)) and `assignedCount`/`responseCount`; only
free-text answers are read from `survey_answers`, capped per question (200).
Same pre-aggregation discipline as 1.5/2.2/3.2, here maintained _incrementally_
(no scheduled job needed) because a survey's shape is fixed at publish.

## 3. The social feed

One `FeedPost` table, three types: `RECOGNITION` (mirrors a PUBLIC recognition,
unique `recognitionId`), `ANNOUNCEMENT` (admin-authored; ORG/BRANCH/DEPARTMENT
scope; optional pin) and `CELEBRATION` (derived).

- **Visibility.** ORG posts → everyone in the tenant (RLS bounds the tenant);
  BRANCH/DEPARTMENT posts → people in that branch/department; a caller with
  `engagement.manage` sees every scope (needed to moderate). `?scope=ALL|ORG|TEAM`
  filters. Reacting/commenting requires being able to _see_ the post (else `404`).
  Pinned posts lead the first page; paging is a `createdAt` cursor (`nextBefore`).
- **Reactions**: one per person per post (`LIKE`/`CELEBRATE`), switching replaces,
  `DELETE` removes. **Comments**: ≤1000 chars, soft-removable. Counts are batched
  per page (page-size-bounded queries, never per-post).
- **Celebrations** are generated by `CelebrationsService` from employee data —
  birthdays (`dateOfBirth`, **month/day only: the year/age is never stored in or
  shown by the post**), work anniversaries (`joinDate`, ≥1 full year) and new
  joiners (≤7 days) for ACTIVE employees. **Idempotent**: each post has a
  `celebrationKey` under `@@unique([tenantId, celebrationKey])` and is written with
  `createMany({ skipDuplicates })`. A daily BullMQ job (`engagement-celebrations`
  queue, 06:00 UTC, the same register-on-boot + per-tenant fan-out shape as 1.5's
  analytics rollup / 3.2's expiry job; KEDA trigger added) runs it; admins can run
  it on demand (`POST /feed/celebrations/generate`). Posts hold **no prose** —
  just kind, subject and `meta` (`{ years }`) — so the UI renders them in the
  viewer's own language. Dates are evaluated in UTC (per-branch "today" is a
  fast-follow). Birthdays are on by default — a tenant-level opt-out is a
  fast-follow worth prioritising where DOB is culturally sensitive.
- **Moderation** is a soft remove (`removedAt` + who + optional reason),
  `engagement.manage` only, audited (`FeedPost`/`FeedComment` `DELETE`). Removing a
  **RECOGNITION** post also **revokes that recognition** (points reversed,
  hidden from leaderboards/profiles). Private recognition is not moderatable —
  admins can't see it (fast-follow: a report-to-HR path).

## API surface

| Route                                                                                                         | Auth                                                            |
| ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `GET /recognition/categories` (`?all=true` for admins)                                                        | authenticated                                                   |
| `POST /recognition/categories`, `PUT /recognition/categories/:id`                                             | `engagement.manage` (audited)                                   |
| `POST /recognition`                                                                                           | `recognition.give` (audited)                                    |
| `GET /recognition/received` · `/given` · `/leaderboard` · `/profile/:employeeId`                              | authenticated (branch-scoped)                                   |
| `GET /surveys/mine` · `/surveys/mine/:id` · `POST /surveys/:id/responses`                                     | authenticated + assigned (404 otherwise); submit is NOT audited |
| `GET/POST /surveys`, `GET/PUT /surveys/:id`, `POST …/publish` · `…/close`, `GET …/results` · `…/respondents`  | `engagement.manage` (writes audited)                            |
| `GET /feed`, `GET /feed/posts/:id/comments`                                                                   | authenticated                                                   |
| `POST/DELETE /feed/posts/:id/reactions`, `POST /feed/posts/:id/comments`                                      | `recognition.give`                                              |
| `POST /feed/posts`, `DELETE /feed/posts/:id`, `DELETE /feed/comments/:id`, `POST /feed/celebrations/generate` | `engagement.manage` (audited)                                   |
| `GET /engagement/overview`                                                                                    | `engagement.manage`                                             |

## Verification

`apps/api/test/engagement.e2e-spec.ts` (real HTTP + real DB + the real BullMQ
notification worker): categories as data; public recognition → recipient
notified (rendered template) → in the feed → leaderboard/points; private
recognition reaches only the recipient; validation (self, inactive, no
profile, out-of-branch); leaderboard branch scope; moderation reverses points
and is audited; survey TEAM/DEPARTMENT/BRANCH targeting, publish → members get it

- a notification, non-members `404`; answer validation, double-submit `409`,
  concurrent double-submit = one response; aggregated results + response rate;
  closed survey refuses answers; **the anonymity proof (raw-table inspection,
  threshold suppression, no identity in results, app-role `UPDATE`/`DELETE`
  denied, non-anonymous contrast)**; feed visibility scopes, reactions
  (switch/remove), comments, moderation (only `engagement.manage`), derived +
  idempotent celebrations; RBAC (every admin route `403` for an employee; a role
  without `recognition.give`); overview; cross-tenant isolation (API + RLS).
  Portal Playwright: `apps/portal/tests/engagement.spec.ts` (incl. the Arabic/RTL
  Doha demo user + axe).

## Demo data

`pnpm --filter @hrm/api run seed:demo` (idempotent — fixed row ids) adds to
`acme-demo`: 5 categories, 9 recognitions (8 public → feed posts, 1 private),
an org feed with a pinned announcement + an Engineering-only post + three
celebrations + reactions/comments, an OPEN identified survey ("Q4 Engagement
Pulse", 2 responses) and an OPEN anonymous one ("Anonymous culture check", 3
responses — above the threshold). Sign in (password `DemoPass-123!`):
`hr@` / `ceo@acme-demo.local` (admin), `intern@` / `lead@` / `pm@acme-demo.local`
(employees; `intern@`/`lead@` have not answered the anonymous survey),
`demo.qa@acme-demo.local` (Doha — Arabic/RTL).

## Known gaps / fast-follows

No points redemption store; no tenant-level opt-out for birthday posts; UTC "today"
for celebrations; no reminders for pending surveys; no per-segment (branch/
department) survey breakdown (deliberately, for anonymity); no survey
templates/question bank; no edit of a posted comment; no report-a-private-
recognition path; no mobile screens; feed has no image/attachments and no
@-mentions (kept "clean and simple — not a full social network").
