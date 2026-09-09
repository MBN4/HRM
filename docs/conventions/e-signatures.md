# E-signatures

[← Back to CLAUDE.md](../../CLAUDE.md) · [Build log](../BUILD_LOG.md)

Defined in step 3.5.3 (Phase 3.5's third slice) — `packages/db`,
`packages/shared`, `apps/api/src/esignature`, `apps/portal`. Builds directly
on [employee.md](./employee.md) (`StorageService`), [payroll.md](./payroll.md)
(the `pdfkit` + bundled-DejaVu-fonts PDF-generation approach, reused
byte-for-byte), [audit-custom-fields.md](./audit-custom-fields.md) (the
`audit_log` DB-level-immutability pattern, applied a second time to this
module's own trail), [notifications-queues.md](./notifications-queues.md)
(the provider seam, invoked directly for a non-`User` recipient), and
[recruitment-lifecycle.md](./recruitment-lifecycle.md) /
[operations-modules.md](./operations-modules.md) (the two real integrations,
Offer acceptance and Policy acknowledgment). Consumes ALL of these; modifies
none of their internals beyond two small, additive touches (see Scope
discipline below).

## The core claim: a tamper-evident evidentiary trail, not just a click

This module's job is not "capture a checkbox" — it is to produce a record
that answers, for any completed signature: WHO signed, WHAT exact bytes they
signed, WHEN (UTC), FROM WHERE (IP/user-agent), and HOW (typed name / drawn
signature / click-to-sign), such that any later tampering with the stored
document is detectable.

- **`SignatureRequest.documentHash`** — a SHA-256 hex digest
  (`document-hash.util.ts`'s `sha256Hex`, plain `node:crypto`, no new
  dependency) of the EXACT bytes at `documentStorageKey`, computed ONCE at
  creation and never recomputed for that field. This is the "what was
  supposed to be signed" reference point.
- **`SignatureEvent`** is the append-only trail itself — one row per
  lifecycle moment (`CREATED`/`SENT`/`VIEWED`/`SIGNED`/`DECLINED`/`EXPIRED`/
  `CERTIFICATE_GENERATED`). A `SIGNED` row is the legally load-bearing one:
  `actorUserId` (internal) or `actorExternalName`/`actorExternalEmail`
  (external), `occurredAt` (UTC, like every timestamp in this codebase),
  `ipAddress`/`userAgent` (lifted from the request the SAME way
  `AuditInterceptor` already does — `req.ip`/`req.headers['user-agent']`),
  `signingMethod`, and its OWN `documentHash` — re-computed FRESH from the
  document's current bytes at the moment of signing
  (`SigningService.sign`), never just copied from
  `SignatureRequest.documentHash`. Two independent hash readings (one at
  creation, one at each signing) is what makes tampering DETECTABLE rather
  than merely asserted.
- **DB-level immutability** — `signature_events` gets the EXACT
  `audit_log` treatment (see audit-custom-fields.md): `hrm_app` is granted
  `SELECT`/`INSERT` only, `UPDATE`/`DELETE` explicitly `REVOKE`d (the
  `enable_rls_for_esignature_module` migration), on top of ordinary RLS.
  Even a fully compromised application process cannot alter or erase a
  recorded signing event. Verified directly against Postgres (not just
  inferred from the SQL) by
  `packages/db/test/signature-event-immutability.spec.ts` — the same
  proof shape `audit-log-immutability.spec.ts` already established.
  `SignatureRequest`/`SignatureSigner` (status, timestamps) and
  `SignatureCertificate` are ordinary mutable tenant-scoped tables — only
  the EVENT trail itself needs to be write-once.
- **Tamper-evidence check, live** — `GET /e-signatures/requests/:id/verify`
  re-downloads the CURRENT bytes at `documentStorageKey`, re-hashes them,
  and compares against `SignatureRequest.documentHash`. A mismatch means
  the stored object was altered after the hash was recorded — proven
  directly by `esignature.e2e-spec.ts` overwriting the object via
  `StorageService.uploadObject` (the exact same seam a compromised process
  would use) and asserting `valid: false`.
- **The certificate is a SEPARATE artifact, never merged into the signed
  document.** `SignatureCertificatePdfService` renders a plain PDF (who
  signed what, when, from where, by what method, and each hash) — the
  "signature CERTIFICATE / audit page" this step's brief asks for — via
  the SAME `pdfkit` + bundled DejaVu-font approach `PayslipPdfService`
  established (see payroll.md). It is generated ONCE, when the LAST signer
  completes (`SigningProgressService.completeRequest`), stored via 1.1's
  `StorageService` at `esignatures/<tenantId>/<requestId>/certificate.pdf`,
  and downloadable independently of the original document
  (`GET /e-signatures/requests/:id/certificate`). Keeping the two artifacts
  separate — rather than stamping a certificate page onto an arbitrary
  uploaded file — is what lets this module accept ANY uploaded document
  type without needing to parse/rewrite it.

## The honest compliance boundary — read this before trusting this module for a specific jurisdiction

**This module provides a strong, tamper-evident EVIDENTIARY MECHANISM — it
does not, by itself, make a signature legally sufficient under any specific
e-signature law.** eIDAS (EU), ESIGN/UETA (US), and countless per-country
requirements each impose their own rules — some require a QUALIFIED/
certificate-based signature backed by a licensed trust-service provider,
some require specific consumer-consent disclosures, some have different
rules for different document types. This module's `CLICK_TO_SIGN`/
`TYPED_NAME`/`DRAWN_SIGNATURE` methods, its IP/UA/timestamp capture, and its
certificate are the SAME kind of evidence most commercial e-sign products
(DocuSign, etc.) build on — but whether that evidence meets a SPECIFIC
jurisdiction's legal bar for a SPECIFIC document type is a legal
determination for the contracting parties and their counsel, not an
engineering one. This is the SAME "the engine computes/records exactly what
it's told to; legal correctness of applying that to a real-world
requirement is a domain-authoring/legal responsibility, not an engine
concern" framing [payroll.md](./payroll.md) and
[benefits.md](./benefits.md) already establish for their own domains — the
compliance-note text is surfaced directly in the portal's request-detail
page (`esignature.detail.complianceNote`), not just written here.

## The polymorphic model — signable documents, signers, and sequencing

- **`SignatureRequest`** — `entityType`/`entityId` (nullable, no FK) is the
  SAME "polymorphic link to a module row that usually doesn't exist yet"
  shape `WorkflowInstance.entityType`/`.entityId` and
  `CustomFieldDefinition.entityType` already establish. `'Offer'`/
  `'Policy'` are the two integrations this step wires up (see below); a
  bare uploaded HR contract has neither. `documentSource` (`UPLOADED` |
  `GENERATED`) plus `documentStorageKey`/`documentMimeType`/`documentHash`
  describe the ONE canonical source document — never rewritten after
  creation.
- **`SignatureSigner`** — `signerType` (`INTERNAL` — a real `User`,
  ESS-reachable via `GET /e-signatures/my-pending`; `EXTERNAL` — no
  account, reached only via a scoped token link) and `order`. **Sequencing
  is its own small mechanism, deliberately NOT the 0.7 workflow engine** —
  signing is an action (sign/decline), never a multi-step approve/reject/
  delegate/escalate DECISION, so pulling in the whole workflow
  condition/approver-rule machinery here would be reuse in name only —
  the IDENTICAL justification [recruitment-lifecycle.md](./recruitment-lifecycle.md)'s
  checklist mini-engine already gives relative to `ApproverRule`. Signers
  sharing an `order` value form a PARALLEL group (all must reach `SIGNED`
  before the next group activates); different `order` values are
  SEQUENTIAL — the same "shares a value = parallel, differs = sequential"
  shape `WorkflowStep.order` established, re-implemented at this module's
  own, much smaller scale (`SigningProgressService.advance`, the one place
  that decides "what's next", mirroring
  `WorkflowEngineService.activateNextGroup`'s role). A genuine multi-party
  APPROVAL need (e.g. "legal must approve this contract before it's ever
  sent out") is a SEPARATE, optional real 0.7 `WorkflowInstance` a
  consuming module may start on its own before creating a
  `SignatureRequest` in the first place — this module has no opinion on
  that, and doesn't need one.
- **A decline fails the whole request, fast** — mirroring workflow
  rejection's own "any REJECT immediately finalizes the whole instance"
  posture, any signer declining sets `SignatureRequest.status = DECLINED`
  immediately; other signers' already-recorded state is frozen, not
  rewritten.

## External signing links — a scoped CAPABILITY, not authentication

- **The same indexed-prefix + argon2id-hash pattern 3.3's `ApiKeyService`/
  `ApiKeyAuthService` already establish**, applied to a per-SIGNER,
  single-DOCUMENT-scoped token instead of a tenant-wide API key
  (`SigningTokenService`). The raw token (`sig_<24 random bytes,
base64url>`) is generated ONCE, at the moment a signer's group activates
  (`SigningProgressService.activateGroup`), handed to the caller so it can
  build the emailed link, and NEVER stored — only `accessTokenPrefix`
  (indexed lookup) + `accessTokenHash` (argon2id, via the SAME `@Global()`
  `HashingService` 3.3 already generalized out of `PasswordService`) are
  persisted on `SignatureSigner`.
- **Deliberately NOT an authentication mechanism.** There is no JWT, no
  RBAC permission, no `TenantScopeInterceptor` auth branch involved at all
  — `ExternalSigningController`'s four routes are all `@AllowAnonymous()`,
  the SAME "public but tenant-required" pattern the 2.3 careers API already
  establishes (see recruitment-lifecycle.md): tenant resolution (Host
  header / `x-tenant-id`) and the request's RLS-scoped transaction still
  apply exactly as for every other route — an external signer just never
  presents a JWT. `SigningService.resolveExternal` looks the token up
  strictly within the CURRENT request's tenant-scoped transaction
  (`tx.signatureSigner.findUnique({ where: { tenantId_accessTokenPrefix }
})`) — a token minted under tenant A is structurally invisible to a
  request resolved under tenant B's Host header, RLS itself enforcing this
  the same way it enforces every other cross-tenant boundary in this
  codebase. Proven directly, not just trusted: `esignature.e2e-spec.ts`
  presents the SAME raw token under tenant B's Host and asserts a `404`,
  presents it as a Bearer JWT against an unrelated authenticated route
  (`GET /employees`) and asserts a `401` (it isn't a JWT at all — this is
  not a general credential), and presents an artificially-expired one and
  asserts `410 Gone`.
- **Grants access to exactly the ONE `SignatureSigner` row it was minted
  for** — not the request, not any other signer, not any other tenant
  data. `resolveExternal`'s result is the ONLY thing the rest of
  `SigningService`'s external-facing methods (`view`/`sign`/`decline`) ever
  operate on.

## Notifications — internal via the real hub, external via a direct provider call

- **Internal signers** are notified through the REAL 0.8 hub, with zero
  new dispatch machinery: `esignature.request_sent` (a signer's turn to
  sign — `signerUserId` direct in the payload, the SAME "no DB query
  needed" shape `workflow.escalated`'s `escalatedToUserId` already uses)
  and `esignature.completed` (the request's creator —
  `createdByUserId`), both added to `NOTIFICATION_EVENT_TYPES`/
  `DEFAULT_NOTIFICATION_CHANNELS` (`packages/shared`) and given one new
  `case` each in `NotificationRecipientResolverService`, plus real EMAIL/
  IN_APP templates (en + ar) in `seed-notification-templates.ts`.
  `DomainEventAuditListener`/`NotificationDispatchListener` each gained one
  mechanical `@OnEvent('esignature.*')` subscription — the same one-line
  addition every prior step's own new event namespace already required.
- **External signers have no `User` row to key a `Notification` on at
  all** — the hub's whole recipient/preference/locale model is User-keyed,
  so `ExternalSignerNotifierService` calls the SAME `EMAIL_PROVIDER` DI
  token DIRECTLY instead of routing through `NotificationsService`. This
  required ONE additive export: `NotificationsModule` now also exports
  `EMAIL_PROVIDER` (previously only `NotificationsService`), so
  `EsignatureModule` can inject it without duplicating a second provider
  binding — still the SAME "swap one binding in `notifications.module.ts`"
  seam a real deployment relies on; nothing about the provider abstraction
  itself changed. A send failure here is logged, never thrown — the
  signing link itself stays valid regardless of whether the notification
  email actually landed (an admin can always relay it out-of-band).
  Documented, honest simplification: the external path has no
  template/locale system (no `User.preferredLanguage` to resolve against),
  so its email body is plain, hardcoded English text — extending it to
  route through a locale-aware template would need a non-`User`-keyed
  extension to `NotificationTemplateRenderer`, not attempted here.

## Integration #1 — Offer letters: acceptance IS the signature

**Zero schema changes to `Offer`.** Whether an offer "requires e-signature"
is expressed ENTIRELY as "a `SignatureRequest` with `entityType: 'Offer'`,
`entityId: offer.id` exists for it" — there is no `Offer.requiresSignature`
column. HR creates one via `POST /e-signatures/requests` with
`generate: { kind: 'OFFER_LETTER', offerId }` (renders the letter from the
Offer/Application/Candidate/Branch data already on file, via
`SignableDocumentPdfService` — the SAME `pdfkit`/DejaVu-font renderer used
for the Certificate and, by extension, for a Policy document below) and an
`EXTERNAL` signer (the candidate has no account). When the candidate signs
and every signer completes,
`EsignatureCompletionSideEffectsListener` — reacting to `esignature.completed`,
the fire-and-forget event-listener shape every cross-module reaction in
this codebase already uses — calls the REAL, completely UNMODIFIED
`OfferService.accept`. That method ALREADY emits `recruitment.offer_accepted`,
ALREADY picked up by the EXISTING `OnboardingOfferAcceptedListener` (2.3,
untouched) — so **a signed offer flows into the real onboarding trigger
with ZERO changes to `apps/api/src/recruitment` or
`apps/api/src/onboarding`.** Proven directly by `esignature.e2e-spec.ts`:
after the external candidate signs, the SAME offer flips to `ACCEPTED`,
the application to `HIRED`, and a real `OnboardingProcess` row appears —
the identical assertions `recruitment-lifecycle.e2e-spec.ts` already makes
for a direct `POST /recruitment/offers/:id/accept` call.

A real, honest safety net rather than a gap: `OfferService.accept`'s own
pre-existing `status !== 'APPROVED'` guard means if someone ALSO calls the
direct accept route while a signature request is still in flight, only the
FIRST caller succeeds — the second gets a `409`, never a double-accept or
a second `OnboardingProcess`. Using e-signature for a given offer is
opt-in per offer, by construction.

## Integration #2 — Policy acknowledgment upgraded to a real signature

**One additive column**: `Policy.requiresSignature` (default `false`).
`PolicyService.acknowledge` gained ONE additive parameter,
`bypassSignatureRequirement` (default `false`): when a policy requires a
signature and the ordinary click-to-acknowledge route
(`POST /policies/:id/acknowledge`) is called without the bypass, it now
`409`s, naming the real path instead. The bypass is set to `true` in
EXACTLY one place — `EsignatureCompletionSideEffectsListener`, reacting to
an `esignature.completed` event whose `entityType === 'Policy'`, which
resolves the (single, internal) signer on the completed request and calls
the SAME real `acknowledge` method — so a signed policy acknowledgment
produces the IDENTICAL `PolicyAcknowledgment` row the old click-based flow
always did (existing admin tracking, `PolicyAckTracker`, needs zero
changes to pick up signed acknowledgments too), PLUS the full evidentiary
trail this step adds.

**A self-service carve-out, not a fourth permission.** Creating a
`SignatureRequest` normally needs `esignature.request` (HR/admin
territory) — but an employee acknowledging their OWN policy shouldn't need
that. `SignatureRequestService`'s `assertMayCreate` grants a row-level
exception: a caller who holds `POLICY_READ` (seeded onto every role,
including `EMPLOYEE`) may create a `generate: { kind: 'POLICY' }` request
with EXACTLY one signer, `INTERNAL`, whose `userId` is their OWN — the
SAME "gated at the row level, an explicit manage-tier permission widens
who may act" shape `InterviewScorecard` submission already establishes
(see recruitment-lifecycle.md). The portal wires this directly into the
existing ESS announcements page (`/announcements`): a `requiresSignature`
policy's action button reads "Sign to acknowledge" instead of
"Acknowledge", creates + sends the request, and hands off to
`/esignature/my` to actually view and sign.

## Generic documents (CUSTOM / UPLOADED) — for everything else

`generate: { kind: 'CUSTOM', title, paragraphs }` covers any other HR
document with no linked entity at all (a confidentiality agreement, an
ad-hoc contract) — rendered by the SAME `SignableDocumentPdfService`.
`POST /e-signatures/requests/upload` (multipart) accepts an arbitrary
uploaded file instead of generating one — `signers` arrives as a
JSON-encoded STRING form field, re-validated against
`z.array(signerInputSchema)` server-side, the SAME "binary content doesn't
fit a JSON string, but everything else that CAN be JSON stays JSON"
convention 1.1's bulk-import CSV-as-a-JSON-string-field already
establishes. Both paths converge on the identical `SignatureRequest`/
`SignatureSigner` creation path — `entityType`/`entityId` stay whatever
the caller (optionally) supplied, with no side-effect listener wired up
for anything other than `'Offer'`/`'Policy'`.

## Branch scoping, RBAC, i18n

- **Branch scoping** mirrors Announcements' own "absence means
  unrestricted, presence never widens" posture: `SignatureRequest.branchId`
  is nullable, populated from the linked entity's own branch when one
  exists (an Offer's `branchId`); `list()` narrows to
  `{ OR: [{ branchId: null }, { branchId: { in: allowedBranchIds } }] }`
  for a branch-restricted caller — a tenant-wide document is never out of
  scope, but a branch-scoped one only ever widens INTO the caller's
  allowed branches, never past them.
- **Three permissions** (`esignature.request`/`.manage`/`.sign`), the SAME
  read/self-service/manage-tier split `EXPENSE_READ`/`.WRITE`/`.MANAGE`
  and `HELPDESK_READ`/`.WRITE`/`.MANAGE` already establish:
  `esignature.request` (create/send — `TENANT_ADMIN`/`HR_MANAGER`),
  `esignature.manage` (cancel any request, tenant-wide tracking list,
  certificate/document download for any request — also `TENANT_ADMIN`/
  `HR_MANAGER`), `esignature.sign` (sign a document YOU are named on —
  seeded onto EVERY role including `EMPLOYEE`). External signers hold NO
  permission at all — they authenticate via the scoped token instead, see
  above.
- **i18n/RTL** — every new UI string lives in `@hrm/shared`'s
  `UI_MESSAGES` (both `en` and `ar`), the SAME catalog every prior step's
  portal work already grew; no new mechanism. The signature-capture UI
  (`SignaturePad`, shared by the ESS `/esignature/my` page AND the
  external `/esign/[token]` page) needs no RTL-specific handling beyond
  the existing logical-Tailwind-utilities convention — it renders inside
  whichever `I18nProvider` context the page is already in. Generated PDF
  documents default to English (`SignableDocumentPdfService`'s `language`
  parameter, unlike `PayslipPdfService` which resolves the real branch
  Country Pack locale) — a documented, deliberate scope simplification,
  not required by this step's own test list; the certificate PDF is
  ALWAYS English/LTR by design, since it's a system-generated evidentiary
  record, not tenant-facing copy.

## The external signing PAGE — a public route outside `(app)`, with a stored tenant slug

`apps/portal/src/app/esign/[token]/page.tsx` lives DIRECTLY under `app/`,
the SAME "unauthenticated screen has no sidebar/session" shape `/login`
already establishes — it is NOT inside the `(app)` route group at all.
Since a fresh external signer has never logged in, there is no stored
tenant slug for the header-based fallback resolution strategy
(`lib/tenant.ts`) to fall back to — so the emailed link carries
`?tenant=<slug>` (alongside a real per-tenant subdomain in production,
where it's simply redundant/ignored by `resolveTenant()`'s subdomain-first
branch), and this ONE page calls the SAME `setStoredTenantSlug()` the
login form already uses, before making any API call. This is a narrow,
page-scoped addition — `lib/tenant.ts`'s `resolveTenant()` itself is
completely unchanged.

## Provider seam for a future dedicated e-sign vendor — documented, not built

Per this step's own scope line: a real DocuSign/Adobe-Sign/etc. integration
is a DOCUMENTED SEAM, not attempted here. The natural extension point is
the SAME shape every other adapter in this codebase already takes (0.4's
`AUTH_PROVIDER`, 0.8's per-channel `NotificationProvider`s, 2.1's
`PAYROLL_PROVIDER_ADAPTER`, 3.3's `BANK_EXPORT_ADAPTER`): a
`SIGNATURE_PROVIDER_ADAPTER` DI token behind an interface like
`{ send(document, signers): Promise<ExternalEnvelopeRef>; getStatus(ref):
Promise<...> }`, with the in-house `SigningTokenService`/`SigningProgressService`
path (built this step) as the default, concrete, always-available
implementation — a real vendor integration would swap ONE binding in
`esignature.module.ts`, exactly like every other seam in this codebase,
without this module's DB schema, evidentiary-trail model, or the
Offer/Policy integrations needing to change.

## Scope discipline — what this step did NOT touch

`apps/api/src/workflow/*` (used as-is only as an OPTIONAL seam a consuming
module may reach for on its own — this module's own sequencing is a
separate, small mechanism, see above), `apps/api/src/recruitment/offers/offer.service.ts`
(called, never edited), `apps/api/src/checklists/*`,
`apps/api/src/payroll/engine/*`, `apps/api/src/country-packs/rules-engine/*`
(untouched — nothing about payroll/pack computation is involved here at
all). Two existing files gained small, additive, mechanical changes:
`apps/api/src/announcements/policy.service.ts` (one new optional parameter
on `acknowledge`, one new `Policy` column) and
`apps/api/src/notifications/notifications.module.ts` (one additional
`exports` entry, `EMAIL_PROVIDER` — no behavior change for any EXISTING
caller of that module). `DomainEventAuditListener`/
`NotificationDispatchListener` each gained one mechanical
`@OnEvent('esignature.*')` line, the same shape every prior step's own new
event namespace already required.

## Known, documented gaps for this phase

Not required by this step's own test list, flagged so they aren't silently
forgotten: no dedicated e-sign PROVIDER adapter (DocuSign/Adobe Sign/etc.)
is actually built — see the seam section above; generated documents
(offer letters, policy text, CUSTOM) always render in English regardless
of the tenant's/branch's resolved locale (`PayslipPdfService`'s own
pack-driven-language precedent was NOT followed here — a documented
simplification, not an oversight); no reminder/escalation sweep for a
signer who never acts (unlike 0.7's `WorkflowEscalationService`/1.3's SLA
sweep, there is no scheduled "nudge an overdue signer" job — a request
just sits `SENT`/`PARTIALLY_SIGNED` indefinitely until someone acts or an
admin cancels it); no `EmployeePicker`/offer/policy picker in the admin
create form — the same documented "type the id, no picker abstraction"
posture frontend-admin-console.md already holds itself to for
interviewer/manager pickers; a qualified/certificate-based (PKI-backed)
signature method is not implemented — only `TYPED_NAME`/`DRAWN_SIGNATURE`/
`CLICK_TO_SIGN`, per the honest compliance-boundary framing above.

Verified end-to-end over real HTTP by `apps/api/test/esignature.e2e-spec.ts`
(21 tests: an internal signer's full evidentiary trail — identity/UTC
timestamp/IP/user-agent/method/document-hash — captured on signing, a
certificate generated on completion, and a live tamper-evidence check
correctly flipping from valid to invalid after the stored document is
overwritten out-of-band; an external candidate signing a generated offer
letter via a token-only link with NO account, that signature flowing into
the REAL `OfferService.accept` → `recruitment.offer_accepted` →
`OnboardingOfferAcceptedListener` chain with zero changes to Recruitment/
Onboarding; the external token proven NOT to be a general credential
(rejected as a Bearer JWT on an unrelated route), NOT to cross tenants
(the identical token 404s under a different tenant's Host header), and to
expire (410 Gone) once past its `accessTokenExpiresAt`; a
`requiresSignature` policy refusing a plain click-to-acknowledge with a
409 and accepting a real signed acknowledgment instead, produced via the
row-level `POLICY_READ` self-service carve-out — and a caller trying to
use that carve-out on someone ELSE's behalf correctly forbidden; RBAC
deny-by-default on both request-creation and tenant-wide listing; and
cross-tenant isolation via RLS) plus
`packages/db/test/signature-event-immutability.spec.ts` (5 tests: the
identical `audit_log`-style DB-level REVOKE UPDATE/DELETE proof, applied
to `signature_events`). `apps/portal/tests/esignature.spec.ts` (5
Playwright tests over the real browser/API/Postgres/Redis/MinIO stack: an
admin creating and sending a request through the real UI, the employee
signing it from `/esignature/my` with a typed signature, the admin seeing
it COMPLETED and the live verify check reporting valid, RBAC-gated nav
visibility, and a QA-branch employee rendering the signing page RTL).
