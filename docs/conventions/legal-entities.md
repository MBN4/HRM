# Multi-legal-entity identity

[← Back to CLAUDE.md](../../CLAUDE.md) · [Build log](../BUILD_LOG.md) · builds on [country-packs.md](./country-packs.md),
[payroll.md](./payroll.md), [statutory-reporting.md](./statutory-reporting.md), [recruitment-lifecycle.md](./recruitment-lifecycle.md),
[e-signatures.md](./e-signatures.md), [tenancy-rls.md](./tenancy-rls.md), [auth-rbac.md](./auth-rbac.md)

Defined in step 12.1. A customer with companies in several countries was already modelled correctly by **branches**: each
branch resolves its own Country Pack (currency, tax, holidays, weekends, payroll). What was missing was the **legal-entity
identity** — the registered name, registration number, tax ID and address that a compliance document must show. This step adds
exactly that, **additively**: no new tenant layer, no change to country resolution, payroll, statutory engines, auth or RLS.

## 1. The model and where it sits

`LegalEntity` (`legal_entities`, tenant-scoped, ordinary `tenant_isolation` RLS + `FORCE`):

| Field                                                                           | Notes                                                                                                                       |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `legalName`, `countryCode`                                                      | The registered company name; ISO-3166 alpha-2. The country is **identity only** — it never drives pack resolution (see §6). |
| `registrationNumber`, `taxId`                                                   | Generic fields. What they are _called_ in a given country comes from the Country Pack (§5).                                 |
| `addressLine1/2`, `city`, `region`, `postalCode`                                | Registered address; printed in `LegalEntityIdentity.addressLines`.                                                          |
| `logoStorageKey`                                                                | Optional logo in object storage (auth-gated download, 2 MB image cap).                                                      |
| `bankNameEncrypted` / `bankAccountNumberEncrypted` / `bankRoutingCodeEncrypted` | Optional payroll bank account, encrypted at rest with the same `EncryptionService` `Employee`'s bank details use (§7).      |
| `isDefault`                                                                     | Exactly one per tenant (partial unique index). What a `null` branch link resolves to.                                       |

A tenant can hold **many** entities. Placement, and why it is the cleanest additive option:

- **`Branch.legalEntityId`** (nullable, composite FK `(tenantId, legalEntityId) → legal_entities(tenantId, id)`, `ON DELETE
RESTRICT`) — each branch belongs to exactly one entity.
- **An employee's entity is derived from their branch** — there is no `Employee.legalEntityId`, so the two can never disagree.
  `GET /legal-entities/:id/employees` lists the employees of the entity's branches (scoped by the caller's branch access).
- **`null` means "the default entity".** `findEntityForBranch()` is the one resolver: branch link → else the tenant's default
  entity → else `null` (a tenant with no entity at all falls back to the pre-12.1 behaviour: the tenant name on documents).
  Because of this fallback every pre-existing fixture, importer (`branch.importer.ts` never sets a link) and raw `branch.create`
  keeps working untouched, and a new branch needs no entity decision.
- **Stamps, not joins, where a record is a historical fact:** `PayrollRun.legalEntityId` (stamped at run creation) and
  `GeneratedReport.legalEntityId` (stamped at generation) so re-assigning a branch later does not rewrite what an already-issued
  run/filing was attributed to. Pre-12.1 rows have `null` and are derived live. Both are **attribution only** — never read by
  `PayrollEngineService` or any report generator.

## 2. Identity resolution (`apps/api/src/legal-entities/legal-entity-identity.util.ts`)

Plain `(tx, …)` functions — **not** a request-scoped service — so the context-less BullMQ processors (payroll, statutory
reporting) can call them, the same reason `resolvePayrollPackConfig` is shaped that way. `LegalEntityIdentity` is the
**document-safe** face: name, country, registration/tax numbers + their labels, address lines, `hasLogo`, `isDefault`. It carries
**no bank details and no storage keys**, so a compliance document cannot leak them even by accident.
`summarizeEntitiesForRows()` attributes a batch (stamped entity wins, else derived from the branch, one lookup per distinct
branch — never per row).

## 3. How documents consume it

| Document                    | Where                                                                                      | What changed                                                                                                                                                                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Payslip**                 | `PayslipService.generate` → `PayslipPdfService`                                            | Employer header = the legal entity (name, address, registration + tax number with labels), resolved from the run's stamped entity else the employee's branch. Reuses the existing renderer; no entity → the old tenant-name header.             |
| **Payroll run**             | `PayrollRunService.createRun`, `toRunDto`                                                  | Run is stamped with the branch's entity; `legalEntity` is surfaced on every run response and on the run detail page. **Attribute, don't recompute** — the engine is untouched.                                                                  |
| **Statutory report**        | `StatutoryReportService.generate`, `StatutoryReportProcessor`, `StatutoryReportPdfService` | The filing is **FOR** the branch's entity: stamped on the register row, shown on every response, a `legalEntityId` filter on `GET /statutory-reports`, and a **"Filer:" block** (legal name, registration/tax IDs, address) printed on the PDF. |
| **Offer letter / contract** | `SignatureRequestService.resolveGeneratedDocument` (`OFFER_LETTER`)                        | The letter opens with "Employer: <legal name>" + registration/tax/address and names the entity as the employing company. The document hash is computed over this exact text, so the signed record identifies the employer.                      |

Generating "per entity": statutory reports remain generated per **branch** (the unit payroll finalizes at); a branch belongs to
exactly one entity, so each filing is for exactly one entity, and two entities always produce separate, correctly labelled reports.
The portal's `/statutory-reports` page can narrow the branch list to one entity. The **CSV export is deliberately unchanged** (it is
meant for upload into an authority's own portal; extra header rows would break that) — the entity identity is on the PDF and in the
register row/API.

## 4. Admin surface

API (`/legal-entities`, JWT + **`entity.manage`**; every mutation audited; RLS-scoped through the request transaction):
`GET /`, `POST /`, `GET|PATCH|DELETE /:id`, `POST /:id/default`, `PUT /:id/branches` (assigning **moves** the branch — it can
belong to only one), `GET /:id/employees`, `POST|GET /:id/logo`. Delete is refused for the default entity and for any entity
still referenced by branches, payroll runs or reports.

`entity.manage` is admin-tier: TENANT_ADMIN/CEO via `ALL_PERMISSIONS`, HR_MANAGER explicitly; never MANAGER/EMPLOYEE.

Portal: `/legal-entities` (`apps/portal/src/app/(app)/legal-entities/page.tsx`) — entity cards (logo, name, country, Default badge,
Country-Pack-labelled identifiers, address, branch chips), create/edit modal, assign-branches modal, employees modal, make-default,
delete. Styled with the shared MBN kit (`Card`/`Badge`/`Modal`/`Button`/`Input`), `en` + `ar` strings, `dir`-aware (`dir="ltr"`
on numbers/codes), light/dark via tokens; axe-clean. `/statutory-reports` gained the entity filter + "filing for" line + per-report
entity; the payroll run detail shows the legal entity.

## 5. Country Pack labels (display only)

`CountryPackConfig.legalEntity?: { registrationNumberLabel, taxIdLabel }` — an **optional** section, so every pre-12.1 pack still
validates. Seeded for US ("State File Number" / "EIN"), QA ("Commercial Registration (CR) No." / "Tax Card No."), PK ("SECP
Company Registration No." / "NTN"). Absent → "Registration number" / "Tax ID". It is read from the active pack of the **entity's**
country and is never read by the tax/statutory engine. The values above are labels, not legal advice — confirm them per client.

## 6. Country resolution is unchanged

A branch still resolves its Country Pack by **its own** `countryCode` (`resolvePayrollPackConfig` etc. were not touched). The
entity's country is a label for the legal person, and a tenant is free to put branches of different countries under one entity
(e.g. the migration's default entity). Asserted in `legal-entities.e2e-spec.ts` (PK/QA runs keep PKR/QAR).

## 7. Security

- **RLS:** `legal_entities` has `tenant_isolation` + `FORCE`; the composite FKs mean a branch/run/report can only ever point at
  an entity of the same tenant. Proven straight against the DB under another tenant's context.
- **RBAC:** `entity.manage` on every route; deny-by-default.
- **Bank details:** encrypted with `EncryptionService` (rotation-aware, like the employee's); the API only ever returns a **masked**
  form (`••••1234`), and `bankDetails` is additionally field-gated behind `salary.view` via `@RequiresPermission` (omitted, not
  nulled — a custom role with `entity.manage` but not `salary.view` sees only `hasBankDetails`). Never in `LegalEntityIdentity`,
  so never on a document. The audit sink's redaction already covers `bankDetails`/`taxId` keys.
- **Audit:** create/update/delete/default/assign-branches/logo upload via `AuditInterceptor`.
- Bank details are stored for **payroll use**; this step does not yet feed them into the bank-export adapter (a documented gap, §9).

## 8. Migration for existing tenants

`20261017090000_add_legal_entities` (table + nullable columns + composite FKs) and `20261017090100_enable_rls_for_legal_entities`
(grants, RLS, the one-default partial unique index, then the **backfill**): one **default** entity per existing tenant — legal name
= the tenant's name, country = the tenant's `default_country_code` — and every existing branch linked to it; plus `entity.manage`
backfilled to TENANT_ADMIN/CEO/HR_MANAGER roles. Idempotent (`NOT EXISTS` / `IS NULL` guards; tested by re-running the statements).
Nothing breaks for a single-entity tenant: same documents, now with the company identity (initially just its name — an admin then
fills in the registration number/tax ID/address). New tenants created through the platform console get a default entity at
provisioning. Multi-country tenants that were modelled as branches keep working: all branches start under the default entity; an
admin creates the other entities and moves branches across.

## 9. Known gaps / honest limits

- A payslip is generated on demand and cached (`PayslipDocument`); one rendered **before** an entity's details were filled in keeps
  its old header until regenerated (payslip regeneration is a pre-existing manual path, unchanged).
- Entity bank details are captured and encrypted but **not yet consumed** by the bank-export adapter (`PayrollBankExportService`).
- Statutory reports are per branch, not an automatic roll-up across all of an entity's branches (see §3).
- Branches have no create/edit API of their own in this codebase (they come from seed/import/platform), so entity assignment is the
  only branch mutation added.
- Registration/tax **format validation** per country is not enforced (free text) — the pack supplies labels only.
- Non-offer contracts: only the offer letter generator exists today; any future contract generator should call
  `findEntityForBranch` the same way.

## 10. Tests

`apps/api/test/legal-entities.e2e-spec.ts` (real HTTP + Postgres + Redis + MinIO): three entities (PK×2, QA) with branches linked;
employee→entity derivation; payslip/report/offer-letter identity per entity (renderer inputs captured); run attribution; Country-Pack
currency unchanged; the legacy single-entity path (null link → default); the migration's backfill statements (idempotent, one
default per tenant, DB refuses a second); RBAC; bank encryption/masking/field-gating; cross-tenant isolation (HTTP + raw RLS); audit.
`apps/portal/tests/legal-entities.spec.ts` (Playwright): the demo tenant's two entities, create/edit/assign/delete through the UI,
statutory-page entity filter, RBAC, RTL (Arabic) + light/dark axe.
