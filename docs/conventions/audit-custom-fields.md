# Audit log & Custom fields

[← Back to CLAUDE.md](../../CLAUDE.md) · [Build log](../BUILD_LOG.md)

Both defined in step 0.9 — `packages/db`, `packages/shared`,
`apps/api/src/audit`, `apps/api/src/custom-fields`. See
[`docs/BUILD_LOG.md`](../BUILD_LOG.md) (the "0.9 audit logging, custom
fields, i18n" entry) for the full file list and verification notes. For the
third 0.9 subsystem (i18n/timezone/RTL), see
[i18n-timezone-rtl.md](./i18n-timezone-rtl.md).

## Audit log

- **Two capture paths, one sink.** `AuditRecordService`
  (`apps/api/src/audit/audit-record.service.ts`) is the ONLY place an
  `audit_log` row is ever written — every `before`/`after`/`metadata`
  payload passes through `@hrm/shared`'s `redactSensitiveFields` there,
  so redaction can never be forgotten at an individual call site.
  - **HTTP mutations**: `@AuditLog(entityType, action)` +
    `@UseInterceptors(AuditInterceptor)` — the same "decorator carries
    metadata, a route-scoped interceptor reads it and does the work"
    shape as `@RequirePermissions()`/`PermissionsGuard` and
    `@RequireFeature()`/`FeatureFlagGuard` (see
    [auth-rbac.md](./auth-rbac.md) for why this is an interceptor, not a
    `CanActivate` guard: `TenantContextService.getTx()` only works once
    `TenantScopeInterceptor`'s interceptor-phase transaction is open).
    `AuditInterceptor` AWAITS the write inside the request's own
    transaction before the response returns — a rollback rolls back the
    audit entry too (correct: if the mutation didn't happen, nothing
    should claim it did), and the caller has a hard guarantee the entry
    exists by the time they see a response. A route handler MAY call
    `AuditCaptureService.setBefore(value)` (backed by its own tiny
    `AsyncLocalStorage`, `audit-capture.store.ts` — deliberately NOT an
    added field on `RequestTenantStore`, since this is scratch
    bookkeeping for one interceptor, not part of the tenant/auth identity
    the rest of the request relies on) to attach a pre-mutation snapshot;
    omitting it just means `before: null` (a CREATE has nothing to
    capture). Wired onto `PUT /country-packs/overrides/:countryCode` (see
    [country-packs.md](./country-packs.md)) as the reference usage — a
    real sensitive tenant-config mutation, not a synthetic demo.
  - **Domain events**: `DomainEventAuditListener`
    (`apps/api/src/audit/listeners/domain-event-audit.listener.ts`)
    subscribes to `auth.*`/`licensing.*`/`workflow.*`/`notification.*`
    (nothing emits under the last namespace yet — subscribed anyway so
    the sink is free the moment something does) — the SAME events
    `AuditEventsListener`/`LicensingEventsListener`/
    `WorkflowEventsListener` used to just structured-log; those three
    placeholder classes are DELETED by this step, superseded exactly as
    each of their own doc comments already promised. Writes via
    `AuditRecordService.recordForTenant`, which opens its OWN fresh
    `withTenantContext` transaction rather than trying to reuse the
    emitting request's — domain events can fire asynchronously after
    that request's transaction has already committed, the same timing
    gap 0.8 documents as "THE RACE" for `NotificationDispatchListener`
    (see [notifications-queues.md](./notifications-queues.md)); never
    throws (logs and swallows) for the same reason 0.8's listener is
    fire-and-forget: the original action already returned a response, an
    audit-sink failure must never look like that action failed.
    `entityType`/`entityId` are derived GENERICALLY (namespace prefix ->
    `PascalCase`; first present of a short list of common id fields), not
    via a per-event switch statement — audit's job is just "record that
    this happened," so this doesn't grow a maintenance burden the way
    `NotificationRecipientResolverService`'s genuinely-necessary
    per-event switch would if reused here. One deliberate, documented
    exception: `licensing.issued`/`licensing.revoked`/
    `licensing.flag_override_set` are always emitted from an
    unauthenticated `@PlatformRoute()` (`LicensingAdminService`), so
    those three are hardcoded as `actorPlatform: true` rather than left
    to the generic derivation, which has no way to know that.
- **Immutability is enforced at the DATABASE layer, not just by no
  application code path updating/deleting it.** The
  `enable_rls_and_immutability_for_audit_log` migration grants `hrm_app`
  only `SELECT`/`INSERT` on `audit_log` and explicitly `REVOKE`s
  `UPDATE`/`DELETE` (defense-in-depth on top of simply never granting
  them, against a future migration accidentally adding a blanket grant)
  — verified directly against Postgres (not just inferred from the SQL)
  in `packages/db/test/audit-log-immutability.spec.ts`: an `UPDATE`/
  `DELETE` through `hrm_app` fails with `permission denied`, even though
  ordinary tenant-scoped RLS (`tenant_isolation`, `USING`/`WITH CHECK`)
  still applies for the `SELECT`/`INSERT` paths that remain. Cascading
  deletes from a `Tenant` row being deleted are unaffected — `ON DELETE
CASCADE` is enforced by the FK constraint itself, not by the deleting
  session's own privilege on the child table.
- **PARTITION-READY, not yet partitioned** — the gap flagged back in 0.2
  (see [tenancy-rls.md](./tenancy-rls.md) and the comment block above the
  `Tenant` model in `schema.prisma`) is closed for the shape, not the
  partitioning itself: `AuditLog`'s primary key is the COMPOSITE
  `(id, occurredAt)`, since Postgres requires the partition key to be
  part of every unique constraint/PK on a partitioned table. Phase 5.2 is
  expected to add the actual `PARTITION BY RANGE (occurred_at)`
  migration; this step's schema is designed so that lands without an
  incompatible PK change.
- **Query API**: `GET /audit` (`apps/api/src/audit/audit.controller.ts`),
  deny-by-default behind a new `audit.read` permission — granted to
  `TENANT_ADMIN` only (via `ALL_PERMISSIONS`), deliberately NOT
  `HR_MANAGER`, the same "ownership/security territory, not HR policy"
  reasoning 0.6 documents for `license.manage` (see
  [licensing-feature-flags.md](./licensing-feature-flags.md)). Filters
  (`entityType`/`entityId`/`action`/`actorUserId`/`before`) are all
  optional; pagination uses a plain `occurredAt < before` cursor (an ISO
  timestamp) rather than Prisma's built-in `cursor` option, which would
  need the table's composite PK — simpler and sufficient for what's
  inherently a "browse recent history" read pattern. Tenant-scoped like
  every other read in this codebase: the query runs through the
  caller's own RLS-scoped transaction, so no filter combination can ever
  surface another tenant's entries.
- Verified end-to-end over real HTTP by `apps/api/test/audit.e2e-spec.ts`
  (a `PUT /country-packs/overrides/:countryCode` mutation auto-capturing
  an audit row with no hand-written write in that route, a second write
  capturing the prior override as `before`, `licensing.revoked`
  landing in the trail via the domain-event sink with `actorPlatform:
true`, `auth.password_reset_requested`'s sensitive `token` field
  redacted before it ever reaches the row, `GET /audit` deny-by-default
  and tenant-isolated) plus
  `packages/db/test/audit-log-immutability.spec.ts` (5 tests: insert
  succeeds, update/delete rejected at the DB level, RLS isolation, no
  tenant context fails loudly).

## Custom fields

- Lets a tenant extend a core entity with its own typed fields WITHOUT a
  schema migration. `CustomFieldDefinition.entityType` is a free-form
  string (the future "Employee", eventually others), the SAME
  polymorphic-by-string pattern `WorkflowInstance.entityType`/
  `Notification.eventType` already use (see [workflow.md](./workflow.md),
  [notifications-queues.md](./notifications-queues.md)), for the same
  reason: a closed catalog here would mean a migration every time a new
  entity becomes custom-field-aware. Both `CustomFieldDefinition` and
  `CustomFieldValueSet` are tenant-scoped, ordinary RLS.
- **Types**: `STRING`/`NUMBER`/`DATE`/`BOOLEAN`/`ENUM` (a Postgres enum,
  `CustomFieldType` — unlike `entityType`, the field TYPE catalog is
  closed and a code-level concern, so an enum is correct here, matching
  `NotificationChannel`/`WorkflowActionType`'s own "some things ARE a
  fixed, closed set" exception to the free-form-string rule). `options`
  (a `string[]`) is required (and non-empty) exactly when `fieldType` is
  `ENUM`, rejected otherwise — enforced by `@hrm/shared`'s
  `defineCustomFieldSchema` (`.strict()` + `.refine()`, the same
  "no meaningless combination accepted" posture
  `tenantCountryOverrideSchema`/`licensePayloadSchema` already use).
- **Storage — one JSONB blob per entity, not one row per field.**
  `CustomFieldValueSet` is `@@unique([tenantId, entityType, entityId])`
  holding ALL of that entity's custom values as a single `{ [fieldKey]:
value }` JSON map — simpler and sufficiently scalable for this step
  than one row per field per entity, matching "typed... with a JSONB
  storage approach" from this step's brief.
- **`setValues` is FULL REPLACE, not a partial PATCH** — the same "PUT
  replaces the whole resource" contract
  `TenantCountryOverride`/`TenantFeatureFlagOverride` already use: the
  submitted body must satisfy every `isRequired` field ON ITS OWN, not
  merged with whatever was previously stored. Every write re-validates
  against the entity type's CURRENT `CustomFieldDefinition` rows — an
  unknown key is a `400`, a missing required field is a `400`, a
  type-mismatched value is a `400` (STRING/NUMBER/BOOLEAN via `typeof`,
  DATE via `Date.parse`, ENUM via membership in that definition's
  `options`) — the same "JSON column has no schema-level guarantee of
  its own" posture as Country Pack config / workflow approver rules /
  every other JSON-configured feature in this system.
- **`CustomFieldsController` is this framework's demo/reference surface,
  not a stand-in for a real entity's own RBAC.** Mutations
  (`POST /custom-fields/definitions`, `PUT
/custom-fields/values/:entityType/:entityId`) are gated on a new
  `custom_field.manage` permission (granted to `TENANT_ADMIN` implicitly
  and `HR_MANAGER` explicitly, alongside
  `country_pack.override.manage` — HR-policy territory, unlike
  `audit.read`); reads are open to any authenticated tenant user, same
  posture as `GET /tenancy/branches`. A future real entity module
  (Employee, ...) is expected to call `CustomFieldValueService`/
  `CustomFieldDefinitionService` directly from ITS OWN
  field-appropriately-permissioned routes (`employee.write`, ...)
  rather than routing through this generic controller — `getValues`'s
  result is meant to be spread into that entity's own response DTO.
- Verified end-to-end over real HTTP by
  `apps/api/test/custom-fields.e2e-spec.ts`: defining a
  STRING/NUMBER/ENUM field (deny-by-default, ENUM-without-options
  rejected), setting values (missing required field / out-of-`options`
  ENUM / unknown key / wrong type all `400`), a full round trip
  (`PUT` then `GET` returns exactly what was set), and tenant isolation
  (tenant B sees no definitions and no values for tenant A's entity).
