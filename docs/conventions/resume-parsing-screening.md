# Resume parsing + candidate screening

[← Back to CLAUDE.md](../../CLAUDE.md) · [Build log](../BUILD_LOG.md)

Step 9.1 — an **extension** of the 2.3 recruitment/ATS module
([`recruitment-lifecycle.md`](./recruitment-lifecycle.md)), not a rebuild: no
change to auth, RLS, the workflow engine or the careers API's
public-but-tenant-scoped posture. Code lives in
`apps/api/src/recruitment/{resume-parsing,screening,candidates}`, schemas in
`packages/shared/src/validators/resume-screening.validator.ts`, UI in
`apps/portal` (`/recruitment/screening/[requisitionId]` + the candidate page).

## What it adds, in one paragraph

When a resume arrives (public careers apply, or a recruiter adds/uploads one)
it is stored through the existing `StorageService`, the candidate is marked
`parseStatus = PENDING`, and a BullMQ job (`resume-parse` queue) parses it
**asynchronously** into a structured `ParsedResume` stored on the `Candidate`.
Each requisition can carry **screening criteria as config data**; every
application is scored 0–100 against them from the candidate's _current_
parsed data (recruiter edits included), with a per-criterion matched/missed
breakdown. Recruiters see a ranked, filterable list. **Nothing here ever
changes an application's stage** — a human advances/rejects exactly as before.

## Data model (migration `20261014090000_add_resume_parsing_screening` + `…090100_enable_rls_for_screening_criteria`)

- `Candidate` (identity row, unchanged) gains: `resumeFileName`,
  `resumeContentType`, `parseStatus` (`NONE|PENDING|PARSED|FAILED`),
  `parsedData` (JSON `ParsedResume`), `parseError`, `parserName`, `parsedAt`,
  `parsedDataEditedAt`/`…By`. Parsed data lives on the **candidate** (a
  resume describes a person, and a re-applicant reuses the row), scores on the
  **application** (a score is relative to one requisition's criteria).
- `Application` gains `screeningScore` (indexed for ranking), `screeningResult`
  (JSON breakdown), `belowThreshold`, `screenedAt`.
- New `ScreeningCriteria` — one row per requisition (`@@unique([tenantId,
requisitionId])`), `config` JSON, re-validated by
  `screeningCriteriaConfigSchema` on every read and write. Ordinary RLS
  (`tenant_isolation`), same as every tenant table.
- No new permission: reading/ranking needs `recruitment.read`; editing parsed
  data, uploading/re-parsing, adding an applicant and defining criteria need
  `recruitment.write`. Requisition-scoped routes honour the caller's branch
  scope (`JobRequisitionService.findById`).

## The parser seam

```ts
// apps/api/src/recruitment/resume-parsing/resume-parser.interface.ts
export const RESUME_PARSER = Symbol('RESUME_PARSER');
interface ResumeParser {
  readonly name: string;
  parse(input: { buffer; fileName; contentType }): Promise<ParsedResume>;
}
class UnparseableResumeError extends Error {} // permanent, file-level failure
```

The same Symbol-token adapter shape as `STRIPE_CLIENT`/`CERT_PROVIDER`.
`RecruitmentModule` binds it by `RESUME_PARSER_PROVIDER`:

| value                                    | binding                                                                                                                                                                                                                                                      |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| unset / `builtin`                        | `BuiltInResumeParser` (default; no external dependency)                                                                                                                                                                                                      |
| anything else (`external-api`, `llm`, …) | `UnavailableResumeParser` — a documented **seam only**; every parse is recorded as FAILED with an explanatory message. It deliberately does _not_ fall back to the built-in parser, so a misconfigured deployment can't silently produce lower-quality data. |

No paid service is signed up for or hardcoded.

### How to swap in a better parser

1. Implement `ResumeParser` (e.g. call a parsing API, or an LLM with a JSON
   schema built from `parsedResumeSchema`). Return a `ParsedResume`; throw
   `UnparseableResumeError` for files it can't read at all, any other error
   for transient failures (BullMQ retries 5× with exponential backoff).
2. Bind it in `createResumeParser()` in `recruitment.module.ts` under a new
   `RESUME_PARSER_PROVIDER` value (keys/URLs from env, never code).
3. That's all. The processor validates whatever comes back against
   `parsedResumeSchema` and canonicalises skills, so a swapped-in parser can't
   write anything the editor/scorer can't read; `Candidate.parserName` records
   which parser produced each result. Scoring, the API and the UI don't change.
   Existing candidates can be re-run via `POST /recruitment/candidates/:id/reparse`.

### The default parser — what it does, and its honest limits

Text extraction: **PDF** via `pdf-parse` v2 (wraps a current pdf.js), run in a
`worker_threads` Worker (untrusted input + CPU-heavy: isolated from the
event loop, 256 MB heap cap, 30 s timeout); **DOCX** via `fflate` (unzip) +
tag-strip of `word/document.xml`; **TXT** as UTF-8. Legacy `.doc`, scanned/
image-only PDFs (no OCR), password-protected PDFs, and anything else →
`UnparseableResumeError` with a plain-language reason.

Field extraction is **heuristic** (`built-in-resume-parser.ts`, parser name
`built-in-heuristic-v1`):

- **email / phone / links** — regexes (phone must have 8–15 digits and is not a
  year range). Reliable.
- **name** — first of the first 10 lines that is 2–4 alphabetic words and not
  a heading/contact line. Right for conventional layouts; wrong for
  multi-column/designer CVs.
- **sections** — headings from a fixed English heading list (Experience,
  Education, Skills, Summary …). A resume with unusual or non-English headings
  gets weaker experience/education extraction.
- **skills** — a **configurable dictionary** (`skills-dictionary.ts`: ~100
  built-in skills with aliases, extendable via `RESUME_SKILLS_DICTIONARY_PATH`)
  matched with word boundaries; ambiguous words ("Go", "R", "Rust", "Swift")
  only count inside a Skills section, case-exact. Unknown items listed under a
  Skills heading are kept verbatim. Skills not in the dictionary and not in a
  Skills list are **missed**.
- **experience** — entries are found by **date ranges** (`Jan 2019 – Present`,
  `06/2015 – 12/2018`, `2018 – 2021`); title/company come from the same line
  or the one/two lines above, split on `at`, `@`, `|`, `-`, `,` and
  disambiguated by a title-word list. Entries without a parseable date range
  are dropped.
- **total years** — union of the dated ranges (overlaps merged, inclusive
  months), falling back to a "N years" claim in the text.
- **education** — degree keywords → a level (`BACHELOR`, `MASTER`, …), with the
  institution from a neighbouring line and the last year found nearby. Bare
  `BS/MS/BA` abbreviations are trusted only inside an Education section.
- English only. No language detection, no layout analysis, no OCR.

Net: good enough to **pre-fill and screen**; expect to correct names, odd
layouts and non-English CVs. That is why the parsed result is always shown and
**editable**, and why a candidate whose parse fails (or returns little) is
never dropped — see below.

## Async flow

```
apply / recruiter upload ─► StorageService.uploadObject ─► Candidate: PENDING (parsedData cleared)
        │                                                    + rescore (old scores invalidated)
        └─► RESUME_PARSE_QUEUE.add('parse', {tenantId, candidateId, storageKey}) ─► returns immediately
worker (ResumeParseProcessor, context-less, short withTenantContext txns):
   download ─► parser.parse ─► validate ─► Candidate: PARSED + parsedData ─► rescore all the candidate's applications
   UnparseableResumeError ─► Candidate: FAILED + parseError   (NOT retried)
   other error ─► BullMQ retries; final attempt ─► FAILED
```

- The job is enqueued from inside the request's still-open RLS transaction, so
  the worker may look for a row that hasn't committed. Hence `delay: 500`, 5
  attempts with exponential backoff, and the processor **throws** on "row not
  visible yet". The job carries the exact `storageKey` it was queued for; if
  the candidate's key has since changed (a newer upload) the job is a no-op, so
  a stale job can never overwrite newer data.
- **Graceful failure.** The candidate and application are created before any
  parsing; a FAILED parse leaves both fully usable. The recruiter sees the
  reason, can enter the fields by hand (`PATCH …/parsed-resume` on a FAILED
  candidate sets status `PARSED`, `parserName: 'manual'`), and can re-parse.
- The apply route's duplicate check (`409`) now runs _before_ the upload, so a
  rejected duplicate leaves no orphan object (reordered in the new shared
  `CandidateIntakeService`, used by both the public and the recruiter route).
- Processors honour `PROCESS_ROLE` like every other queue (`shouldAutorunWorkers()`),
  and `deploy/k8s/base/worker-hpa-keda.yaml` scales workers on `bull:resume-parse:wait`.
- The worker emits `recruitment.resume_parsed` / `recruitment.resume_parse_failed`
  (ids + status only, **no PII**), picked up by the existing generic
  `recruitment.*` audit subscription (`candidateId` added to its entity-id field list).

## Screening criteria + scoring

Criteria (`ScreeningCriteriaConfig`, config data on the requisition):
`requiredSkills`, `preferredSkills`, `minYearsExperience`, `minEducation`,
`keywordMustHaves`, per-criterion `weights` (defaults 40/15/20/10/15), and
`belowThresholdScore` (default 40). Skills are canonicalised on save and on
compare through the same dictionary the parser uses, so "js", "JavaScript" and
"ECMAScript" never produce a false "missed".

`scoreResume(parsed, config)` (`screening-scorer.util.ts`) is a **pure
function**:

- Only criteria the requisition actually configured count; weights are
  **re-normalised over the configured set** (a requisition that only lists two
  required skills isn't capped at 40/100).
- Skills / keywords: proportional (`matched / wanted`) → `MET` / `PARTIAL` /
  `MISSED`. Experience: `min(1, actual / required)`. Education: binary against
  the highest detected level. Keywords match whole words, case-insensitively,
  over the extracted text + skills + job titles.
- Score = rounded sum of earned points. `belowThreshold = score < threshold`.
- A candidate with no `PARSED` data (pending/failed/none) or a requisition
  with no criteria gets **`null`** — shown as "Not scored", never `0`.

**Transparency**: `Application.screeningResult` stores, per criterion, status,
`earnedPoints`/`maxPoints` (they sum to the score), the matched and missed
items and a one-line detail; plus `basedOnEditedData`. The UI's "Why this
score?" shows all of it (status is text + icon, never colour alone).

**When scores are recomputed** (always synchronously, inside the triggering
transaction): criteria saved/deleted (every application under the requisition,
bounded at 5,000 per pass), a parse finishes/fails, a resume is replaced or
re-parsed, a recruiter edits the parsed data, a returning candidate applies
to a new posting. **Edited data is what gets screened**: the edit overwrites
`parsedData` in place, stamps `parsedDataEditedAt`, and re-scores; `rawText` is
server-owned and preserved across edits. A re-parse/replacement deliberately
discards edits (the UI confirms).

**Human in the loop.** Scoring writes only the four screening columns on
`Application`. No code path in this module touches `stage`; below-threshold is
a badge/filter, and advancing/rejecting stays the existing
`PATCH /recruitment/applications/:id/stage` (still audited).

## API (all under `/recruitment`, existing permissions)

| route                                                        | perm         | notes                                                                                                                                                              |
| ------------------------------------------------------------ | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET/PUT/DELETE requisitions/:id/screening-criteria`         | read / write | PUT/DELETE re-score the requisition's applicants; audited (`ScreeningCriteria`)                                                                                    |
| `GET requisitions/:id/ranked-applications`                   | read         | `?minScore&minYears&skill&stage&belowThreshold&jobPostingId&sort=score\|experience\|appliedAt` (bounded to 200; parsed-JSON filters apply in memory over that set) |
| `GET applications/:id/screening`                             | read         | parse state + parsed fields + score + breakdown + criteria in one call                                                                                             |
| `PATCH candidates/:id/parsed-resume`                         | write        | recruiter edit / manual entry; audited; `409` while `PENDING`                                                                                                      |
| `POST candidates/:id/resume` · `POST candidates/:id/reparse` | write        | upload/replace; re-run the parser                                                                                                                                  |
| `GET candidates/:id/resume`                                  | read         | original file download (`Content-Disposition: attachment`)                                                                                                         |
| `POST postings/:id/applicants`                               | write        | recruiter adds an applicant (+ optional resume), multipart                                                                                                         |

The public `POST /careers/postings/:slug/apply` is unchanged in shape and still
`@AllowAnonymous()` + tenant-scoped, but its response now **strips** the
screening columns: an unauthenticated caller must never learn their (or a
returning applicant's) score. `GET /recruitment/candidates[/:id]` never returns
`parsedData.rawText` (`toCandidateView`).

## PII, privacy, audit

Parsed data is ordinary candidate data: it lives on the `Candidate` row, so the
6.1 export includes it (`profile` is the whole row), the `CANDIDATE_RECORDS`
erasure/retention hard-delete removes it with the row, and RLS isolates it.
`rawText` was added to the audit redaction key pattern so extracted resume text
can never land in `audit_log`. Mutating routes are `@AuditLog`'d. The original
resume object is the existing 2.3/1.1 storage object (no new retention mechanism).
Known gap: replacing a resume leaves the previous object in storage (deleting it
inside the request transaction would lose it if the transaction later rolled back).

## UI (apps/portal, MBN design system, en + ar, RTL/light/dark via tokens + logical CSS)

- `/recruitment/screening/[requisitionId]` — criteria summary + editor modal;
  ranked table (score bar + number, parse-status badge, experience/education,
  skill chips, the stage select, expandable "Why this score?"); filters;
  "Add applicant"; auto-polls while any resume is `PENDING`. Entry point: a
  "Screening" button on each APPROVED/CLOSED requisition in `/recruitment`.
- Candidate page — `ParsedResumePanel` (status, download/replace/re-parse,
  parsed fields view + editor, manual entry for failed parses) and, per
  application, the score + breakdown.

## Not done / fast-follow

- **Screening questionnaires** (attach questions to an application, capture
  answers) — deliberately not built; it is independent of parsing/scoring and
  would need its own table + public-form support.
- LLM / API parser adapters (the seam exists; nothing is implemented or paid for).
- OCR for scanned PDFs; non-English heading dictionaries.
- Re-scoring is synchronous and bounded at 5,000 applications per pass — a
  requisition larger than that needs a queued re-score.
- Portal-side only: no mobile UI.

## Tests

- `apps/api/test/resume-screening.e2e-spec.ts` (23, real HTTP + Postgres +
  Redis + MinIO + BullMQ): real pdfkit-generated PDF and a DOCX parsed async;
  unparseable + scanned files fail gracefully; criteria → scores → ranking →
  matched/missed; filters; edits re-score from edited data; manual entry;
  stages untouched by scoring; recruiter upload/add-applicant/re-parse;
  RBAC; cross-tenant isolation; public apply stays public + tenant-scoped and
  leaks no score; audit rows.
- Unit: `built-in-resume-parser.spec.ts`, `screening-scorer.util.spec.ts`.
- `apps/portal/tests/screening.spec.ts` (Playwright, real browser).
- The pre-existing `recruitment-lifecycle.e2e-spec.ts` passes unchanged.
