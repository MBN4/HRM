# Employee

[← Back to CLAUDE.md](../../CLAUDE.md) · [Build log](../BUILD_LOG.md)

Defined in step 1.1 (Phase 1) — `packages/db`, `packages/shared`,
`apps/api/src/employees`, `apps/api/src/common/encryption`,
`apps/api/src/storage`. See [`docs/BUILD_LOG.md`](../BUILD_LOG.md) (the
"1.1 employee module" entry) for the full file list and verification notes.
This is the first Phase 1 module — it builds directly on
[tenancy-rls.md](./tenancy-rls.md), [auth-rbac.md](./auth-rbac.md),
[field-level-permissions.md](./field-level-permissions.md),
[country-packs.md](./country-packs.md),
[audit-custom-fields.md](./audit-custom-fields.md),
[notifications-queues.md](./notifications-queues.md) (the BullMQ pattern),
and [workflow.md](./workflow.md) (the approver-rule seams it now feeds real
data). Nothing about tenancy/RLS, auth/RBAC, resilience, or any other Phase
0 mechanism needed to change for this module to exist — the whole point of
Phase 0 being "complete" (see CLAUDE.md § 6).

- **The model.** `Employee` is tenant-scoped, ordinary RLS applies — same
  pattern as every other table in this schema (see
  [tenancy-rls.md](./tenancy-rls.md)). `userId` is a NULLABLE, per-tenant-
  unique one-to-one link to `User`: an employee doesn't strictly need a
  login account (freshly bulk-imported and not yet provisioned is the
  common case). `managerId` is a composite self-relation, same pattern as
  `Branch.parentBranchId`/`Department.parentDepartmentId`/`User.managerId`
  — this is now the REAL org-chart data source (see "Feeding the workflow
  engine" below). Three small satellite tables — `EmployeeDependent`,
  `EmployeeEmergencyContact`, `EmployeeDocument` — plus `EmployeeImportJob`
  (bulk import tracking, see below) round out the schema.
- **Encryption at rest, and field-level omission — two independent,
  stacked controls.** `Employee.bankAccountNumberEncrypted`/
  `bankNameEncrypted`/`bankRoutingCodeEncrypted`/`baseSalaryEncrypted` are
  application-level AES-256-GCM ciphertext (`EncryptionService`,
  `apps/api/src/common/encryption`), stored as `<iv>:<authTag>:<data>`
  (base64 each) — a fresh random IV per encryption call, the GCM auth tag
  travels alongside so `decrypt` verifies integrity as well as decrypting
  (tampering raises, rather than silently returning garbage). The key
  (`FIELD_ENCRYPTION_KEY`, base64-encoded 32 bytes) is read once at
  construction and fails LOUDLY if missing/wrong-length — the same "no
  `missing_ok`" posture RLS's `current_setting` and Country Pack resolution
  already hold themselves to. This is a SEPARATE control from field-level
  permission gating: `EncryptionService` protects the DATABASE COLUMN
  (encrypted regardless of who's asking), `@RequiresPermission()`/
  `PermissionSerializerInterceptor` (see
  [field-level-permissions.md](./field-level-permissions.md)) protects the
  API RESPONSE (decrypted server-side either way, then OMITTED — not
  nulled — from the JSON for a caller without `salary.view`). Both apply to
  `compensation` simultaneously; `bankDetails` gets ONLY the encryption
  control (the task only asked salary to be field-level gated) —
  consistent with this project's "no single layer of security is trusted
  alone" posture (see [tenancy-rls.md](./tenancy-rls.md)). `salary.view`
  and `EMPLOYEE_READ`/`EMPLOYEE_WRITE` were already seeded in 0.4 in
  anticipation of this exact module (see
  [field-level-permissions.md](./field-level-permissions.md)'s reference
  DTO) — no new permission keys were needed.
- **Country-driven required fields — THE RULE proven for real.**
  `Employee.statutoryFields` is a `{ [fieldKey]: string }` JSON map giving
  concrete meaning, for the first time, to Country Pack
  `requiredEmployeeFields`'s opaque keys (0.5's own doc comment explicitly
  deferred this to "the future employee-fields module" — see
  [country-packs.md](./country-packs.md) — this is that module).
  `EmployeeService` validates every create, and every update that touches
  `branchId`/`statutoryFields`, by resolving the effective Country Pack for
  the employee's branch and requiring every currently-required key to be
  present and non-blank — a 400 lists exactly which keys are missing. NO
  country code is ever branched on: the SAME validation function runs for
  a US branch (`SSN`/`W4`) and a QA branch (`QATAR_ID`/
  `VISA_SPONSORSHIP`), driven entirely by the resolved pack's data — proven
  by `apps/api/test/employees.e2e-spec.ts`'s "same code path, different
  pack" tests.
  - **Why this does NOT reuse `CountryPackResolutionService` directly**
    (`apps/api/src/employees/employee-country-pack.util.ts`,
    `resolveRequiredEmployeeFields`): that service reads
    `TenantContextService.getTx()`/`.tenantId` internally, which only
    exist inside an HTTP request's `AsyncLocalStorage` context — but this
    validation must run from BOTH an HTTP request (create/update) AND the
    bulk-import BullMQ worker (no request context at all). This is the
    EXACT constraint `NotificationLocaleResolverService` (0.8) and
    `WorkflowEscalationService` (0.7) already document for themselves —
    solved the same way: duplicate the couple of small lookup queries with
    an explicit `tx`/`tenantId` signature, while still reusing the actual
    MERGE logic (`mergeCountryPackConfig`) as-is, since it's a plain
    function with no request-context dependency — the two-layer override
    model can never drift between request-time resolution and this one.
- **Custom fields — the first real consumer.** `EmployeeService` calls
  `CustomFieldDefinitionService`/`CustomFieldValueService` directly with
  `entityType: 'Employee'` (`EMPLOYEE_ENTITY_TYPE`,
  `apps/api/src/employees/employee.constants.ts`) — exactly the reuse
  `custom-field-value.service.ts`'s own doc comment invited ("a future
  real entity module (Employee, ...) is expected to call `getValues` and
  spread its `values` into that entity's own response DTO, and `setValues`
  from its own create/update handler"), not routed through the generic
  `CustomFieldsController` (see
  [audit-custom-fields.md](./audit-custom-fields.md)). `customFields` is
  spread into `EmployeeResponseDto` on every read; `setValues` is called
  on every create (with `input.customFields ?? {}`, so a REQUIRED custom
  field is enforced from an employee's very first write) and on update
  only when the patch body includes `customFields` (full-replace, same
  contract 0.9 established — an omitted `customFields` on a `PATCH` leaves
  the existing set untouched).
- **CRUD + branch scoping.** `EmployeeService` takes `tx`/`tenantId`
  EXPLICITLY on every method rather than reading them off
  `TenantContextService` — deliberately, since it's called from both
  `EmployeesController` (has a `TenantContextService`-backed context) and
  the bulk-import worker (does not). Branch scoping (see
  [auth-rbac.md](./auth-rbac.md) → Branch scoping) is enforced entirely in
  the service layer, reading `allowedBranchIds` passed in from the
  controller's `tenantContext.getBranchIds()`: a restricted caller gets
  `403` creating/updating outside their allowed branches, and `404` (not
  `403`) reading/listing an employee outside them — the same
  "non-disclosure via 404" posture 0.8's notification mark-read route
  already holds itself to. List pagination is offset-based, capped
  (`MAX_PAGE_SIZE = 100`, default 20) — "no unbounded queries" — and every
  filter (`branchId`/`departmentId`/`status`) hits an index already on the
  table (`@@index([tenantId, branchId])` etc.); `search` (name/employee
  code substring) does NOT hit an index, a documented, accepted scaling
  tradeoff for this phase, same "documented, not silently accepted"
  posture 0.3/0.7 already hold themselves to elsewhere in this codebase.
- **Bulk import — the 0.8 BullMQ pattern, reused as-is.**
  `POST /employees/import` accepts CSV content as a JSON string field
  (not multipart — kept inside this codebase's "one validation paradigm"
  posture, zod-validated JSON bodies, for this one route; document upload
  below IS multipart, since binary content genuinely doesn't fit a JSON
  string). `EmployeeImportService.submit` creates an `EmployeeImportJob`
  row (`PENDING`, `totalRows` pre-counted) and enqueues ONE job — mirrors
  `NotificationsService.handleDomainEvent`'s producer shape exactly (see
  [notifications-queues.md](./notifications-queues.md)).
  `EmployeeImportProcessor` (the worker) reloads `csvContent` FRESH from
  the row (never from `job.data`, which stays minimal —
  `{ tenantId, importJobId }` — the same "job data stays minimal,
  everything reloaded from the DB" posture 0.8's `NotificationProcessor`
  established) and processes EACH ROW IN ITS OWN `withTenantContext`
  transaction — genuine row-level isolation: one bad row's validation
  failure can never roll back rows that already succeeded, and re-uses
  the SAME `createEmployeeSchema`/`EmployeeService.create` the real `POST
/employees` route uses (`apps/api/src/employees/import/csv-row.util.ts`),
  so a CSV row and a direct API call are validated identically. Progress
  (`processedRows`/`successCount`/`errorCount`/`errors: [{row, message}]`)
  is written back after every row, pollable via `GET
/employees/import-jobs/:jobId`.
  - **The same race 0.8 documents ("THE RACE"), handled more simply
    here.** `submit()` runs inside the request's own held-open transaction
    (`TenantScopeInterceptor`), so `queue.add()` can genuinely fire before
    that outer transaction commits — a worker looking up `importJobId`
    immediately could find nothing yet. Rather than hand-rolling a second
    bounded-retry loop (0.8's approach, needed there because recipient
    resolution has no other retry mechanism to lean on),
    `EmployeeImportProcessor` just throws if the row isn't there yet, and
    BullMQ's own `attempts`/`backoff` (the identical `JOB_OPTIONS` shape
    0.8 established) retries it — by the second attempt (~1s later) the
    outer transaction has certainly committed. Simpler, because the retry
    mechanism this needed already existed in the infrastructure every
    BullMQ job in this system gets for free.
- **Documents — metadata in Postgres, bytes in S3/MinIO.** `EmployeeDocument`
  rows (tenant-scoped, RLS) hold metadata only; the actual bytes live in
  object storage via a NEW reusable seam, `StorageService`
  (`apps/api/src/storage`, `@Global()`, same "any future module just
  imports this" posture `QueueModule`/`EncryptionModule` hold themselves
  to) — the FIRST real use of the `S3_*` env vars documented (and unused)
  since step 0.1. Objects are addressed by a caller-constructed key
  (`employees/<tenantId>/<employeeId>/<documentId>-<fileName>` —
  tenant-partitioned in the bucket layout itself, defense-in-depth
  alongside, never instead of, the RLS-scoped `employee_documents` row
  that's the actual authorization boundary). Uploads use
  `@nestjs/platform-express`'s `FileInterceptor` (in-memory buffer, a
  20MB cap); downloads STREAM the object back through the API
  (`StreamableFile` wrapping the S3 SDK's readable body) rather than a
  presigned URL — simpler for local dev (MinIO's container-internal
  endpoint isn't externally reachable without extra reverse-proxy config)
  and keeps every document access subject to this app's own RBAC/RLS
  checks on the way out, not a separately-time-limited unauthenticated
  URL.
- **Audit — salary changes are captured, values redacted.** Both
  `POST /employees` and `PATCH /employees/:id` are `@AuditLog`'d (same
  `@UseInterceptors(PermissionsGuard, AuditInterceptor, ...)` shape every
  other mutating route in this codebase uses — see
  [audit-custom-fields.md](./audit-custom-fields.md)); `PATCH` additionally
  calls `AuditCaptureService.setBefore()` with the pre-update employee DTO
  (fetched via the same `EmployeeService.findById` the `GET` route uses,
  so `before`/`after` are directly comparable), the same reference usage
  `country-packs.controller.ts`'s `putOverride` established in 0.9.
  `@hrm/shared`'s audit redaction pattern
  (`REDACTED_KEY_PATTERN`, see [audit-custom-fields.md](./audit-custom-fields.md))
  was extended to also match `bankDetails`/`compensation` — the whole
  CONTAINER key, not each leaf field (which also catches `salaryCurrency`,
  not sensitive on its own but not worth a narrower carve-out either,
  consistent with this pattern's "safer to over-redact" posture) — so a
  salary CHANGE is fully auditable (who, when, that a change happened) with
  the actual salary value never reaching `audit_log` in either `before` or
  `after`.
- **Feeding the workflow engine's approver-rule seams — the change 0.7
  predicted.** `Branch.headUserId`/`Department.headUserId`/
  `User.managerId` (0.7) were explicitly documented as PLUGGABLE SEAMS
  pending this exact module — see [workflow.md](./workflow.md) → Approver
  rules: _"When 1.1 lands, only the two private
  `resolveRequesterBranchId`/`resolveRequesterDepartmentId` helpers below
  should need to change to query real employee data — the engine, the
  `ApproverRule` type, and every other rule kind are unaffected."_
  `apps/api/src/workflow/approver-resolver.service.ts` was updated exactly
  as predicted, PLUS the `MANAGER` case itself (not originally called out,
  but the same shape):
  - `MANAGER` now resolves `Employee.managerId` (found via the requester's
    linked `Employee.userId`) to that manager Employee's OWN linked
    `userId`, falling back to the legacy `User.managerId` seam column only
    for a requester with NO `Employee` record at all (an admin-only
    account never onboarded as an employee) — so nothing that worked
    before 1.1 regresses.
  - `resolveRequesterBranchId`/`resolveRequesterDepartmentId` now prefer
    the requester's `Employee.branchId`/`departmentId` (after the
    instance's explicit `dataSnapshot.branchId`/`.departmentId`, which
    still wins first), falling back to the original 0.7 heuristics
    (`UserBranch`, or nothing at all for `DEPARTMENT_HEAD`, which had no
    fallback before this step) for a requester with no `Employee` record.
  - Proven end-to-end, not just unit-tested: `apps/api/test/employees.e2e-spec.ts`
    seeds a real `MANAGER`-rule `WorkflowTemplate`, links two `User`
    accounts to two `Employee` rows with a real `managerId` relationship,
    starts an instance as the subordinate, and asserts the RESOLVED
    eligible approver is the real manager's `userId` — then that manager
    can actually approve it.
- **API surface** (`apps/api/src/employees/employees.controller.ts` +
  `apps/api/src/employees/documents/employee-documents.controller.ts`):
  `POST /employees`, `GET /employees` (paginated/filtered), `GET
/employees/org-chart` (registered BEFORE `GET /employees/:id` in the
  controller — Nest/Express route matching needs a literal path segment
  declared before a colliding `:id` param route), `POST /employees/import`,
  `GET /employees/import-jobs/:jobId`, `GET /employees/:id`, `PATCH
/employees/:id`, and (nested under `employees/:employeeId/documents`)
  `POST`/`GET`/`GET :documentId` for document upload/list/download. Every
  mutating route is deny-by-default (`employee.write`); reads need
  `employee.read`; both were seeded onto system roles back in 0.4 in
  anticipation of this module. `PermissionSerializerInterceptor` is applied
  to every route that returns an `EmployeeResponseDto`.
- **Org chart** (`apps/api/src/employees/org-chart.service.ts`): derives
  the reporting hierarchy purely from `Employee.managerId` among `ACTIVE`
  employees (a terminated employee's old reporting line would be actively
  misleading to show), branch-scoped the same way employee list/get are.
  An employee whose manager is outside the query's scope (different
  branch, inactive, or genuinely has none) becomes a ROOT of the returned
  forest rather than being silently dropped.
- **Known, documented gaps for this phase** (not required by this step's
  brief, flagged so they aren't silently forgotten): no manager-chain
  CYCLE detection beyond "can't be your OWN manager" (a real cycle
  A→B→A would currently be accepted); dependents/emergency contacts are
  full-replace arrays embedded in the employee create/update payload, not
  their own CRUD endpoints (no test in this step's required list needed
  more than that); bulk import is CSV only, not Excel (`.xlsx`), per this
  step's own scope call — extending to Excel would mean adding a real
  spreadsheet-parsing dependency (`exceljs`/`xlsx`) for comparatively
  little benefit over "export to CSV first."
- Verified end-to-end over real HTTP (including real MinIO for document
  upload/download, not a mock) by `apps/api/test/employees.e2e-spec.ts`
  (15 tests: CRUD with RBAC + branch-scoping including a branch-restricted
  caller blocked from creating outside their branch and unable to see an
  employee outside it; field-level `salary.view` include/omit;
  encrypted-at-rest bank/salary verified directly against the raw DB row —
  not plaintext, correct `<iv>:<tag>:<data>` shape; the SAME code path
  resolving opposite required-field sets for a US vs. a QA branch, both
  the missing-fields 400 and the accepted-with-fields 201; custom field
  validation (out-of-`options` ENUM rejected) and round-trip via create,
  GET, and update; the real `Employee` org chart resolving 0.7's `MANAGER`
  approver rule end-to-end, including an actual approval; the org chart
  endpoint reflecting a real manager/reports hierarchy; bulk import
  processing valid rows and reporting a per-row error for an invalid one,
  polled to completion async; a document uploaded, listed, and downloaded
  byte-for-byte identical; and cross-tenant isolation — RLS, not
  application code, is what blocks tenant B from reading or listing
  tenant A's employees).
