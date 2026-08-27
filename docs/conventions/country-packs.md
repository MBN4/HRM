# Country packs

[← Back to CLAUDE.md](../../CLAUDE.md) · [Build log](../BUILD_LOG.md)

Defined in step 0.5 — `packages/db`, `packages/shared`,
`apps/api/src/country-packs`. See [`docs/BUILD_LOG.md`](../BUILD_LOG.md)
(the "0.5 country packs" entry) for the full file list and verification
notes.

- **THE RULE.** No module may ever branch on a country code
  (`if (countryCode === 'US')` or equivalent). Every behavior that
  legally/culturally differs by country — currency, weekend days, leave
  entitlements, public holidays, income tax, statutory contributions,
  required employee fields, payslip layout, payroll mode — must be read
  from `CountryPackResolutionService`'s resolved effective config, never
  hardcoded elsewhere. The two reference packs (USA, Qatar — see below)
  exist specifically to prove this: same code path, opposite behavior,
  driven entirely by data.
- **Schema** (`packages/shared/src/validators/country-pack.validator.ts`,
  `countryPackConfigSchema`): `locale` (currencyCode/currencySymbol/
  numberFormat/dateFormat/defaultLanguage/rtl/firstDayOfWeek),
  `workingTime` (standardWeeklyHours/weekendDays[]/overtimeRules),
  `leaveDefaults` (annual/sick/maternity/paternity day counts),
  `publicHolidays` (a calendar keyed by 4-digit year, seedable one year at
  a time), `tax` (`{ layers: TaxLayer[] }` — see Rules engine below;
  empty array is valid and means "no income tax", e.g. Qatar — this is a
  data state, not a special-cased skip), `statutory` (`{ components:
StatutoryComponent[] }`), `requiredEmployeeFields` (opaque string keys,
  e.g. `["SSN","W4"]` / `["QATAR_ID","VISA_SPONSORSHIP"]` — meaning lives
  in the future employee-fields module, not here), `payslipTemplate`
  (language + ordered line items), `payrollMode` (`CALCULATE` |
  `DELEGATE`), `hostingRegionHint` (advisory only, never a hard
  data-residency enforcement by this schema alone).
- **Rules engine — the SAFE evaluator (SECURITY BOUNDARY).**
  `tax.layers`/`statutory.components` entries with `kind: 'FORMULA'`
  carry an `Expr` value — a fixed, whitelisted JSON AST (`{type:'const'|
'var'|'binary'|'clamp', ...}`, `@hrm/shared`'s `exprSchema`/
  `ALLOWED_EXPR_VARIABLES`/`ALLOWED_EXPR_OPERATORS`) — **never** a string
  to be parsed or `eval`'d, and there is no mechanism anywhere in this
  system for a pack/override to carry executable code. `apps/api/src/
country-packs/rules-engine/expression-evaluator.ts`'s `evaluateExpression`
  is the ONLY function that executes it: a structural tree-walking
  interpreter that matches every node/operator/variable against that
  same fixed whitelist and throws `UnsafeExpressionError` on anything
  else. This is validated on TWO independent layers — `exprSchema` at
  every pack/override write AND read, and the evaluator's own runtime
  check — consistent with this project's "no single layer of security is
  trusted alone" posture; extending the whitelist (a new operator/
  variable) is a deliberate, reviewed code change, never a runtime
  config option. `PROGRESSIVE_BRACKETS`/`FLAT_RATE` (tax) and
  `PERCENTAGE`/`TIERED_BY_YEARS_OF_SERVICE` (statutory) are fixed, generic
  algorithms parameterized entirely by pack data — `FORMULA` exists only
  for what those shapes can't express. `apps/api/src/country-packs/
rules-engine/{tax-calculator,statutory-calculator}.ts` compute layers/
  components from this data; the SAME function computes every country's
  result, e.g. `computeMultiLayerTax(pack.tax.layers, variables)` for
  both a 4-layer US pack and Qatar's `layers: []`. This whitelisted-AST
  SECURITY PATTERN (not the file) is reused by 0.7's workflow condition
  evaluator — see [workflow.md](./workflow.md) → Conditional branching.
- **Country resolution.** `CountryPackResolutionService.
resolveCountryCodeForBranch(branchId)`: `Branch.countryCode` (required
  at the DB level today) is the primary source; `Tenant.defaultCountryCode`
  is only a fallback for a branch without one — defensive/forward-looking
  given the current NOT NULL column, per this note's original placeholder
  here since 0.2/0.3. `resolveEffectiveConfig(countryCode)` then loads
  the active `CountryPack` (`isActive: true`, highest `version`) — no
  active pack for a country is a loud `404` (`CountryPackNotFoundError`),
  never a silent generic default, consistent with the RLS
  "no `missing_ok`" philosophy (see [tenancy-rls.md](./tenancy-rls.md)).
- **Two-layer override model.** `CountryPack.config` (system-owned legal/
  cultural defaults, versioned per country) merged with an optional
  `TenantCountryOverride.overrides` (a tenant's diff on top, e.g. "25
  days annual leave vs. the pack's 21-day legal floor") =
  `mergeCountryPackConfig()`'s effective config
  (`apps/api/src/country-packs/country-pack-override.util.ts`). Only
  `leaveDefaults`/`workingTime`/`requiredEmployeeFields`/`payslipTemplate`
  are ever tenant-overridable — `tenantCountryOverrideSchema` is `.strict()`,
  so an override payload naming `tax`/`statutory`/`locale`/`payrollMode`
  fails validation outright; a tenant can never weaken a legal/compliance
  default. Bounds are enforced where sensible, e.g. `leaveDefaults`: a
  tenant may only grant MORE than the pack's legal floor, never less
  (`assertLeaveBoundsRespected`, a `400` at override write-time via `PUT
/country-packs/overrides/:countryCode`) — and defensively clamped UP to
  the floor again at every resolution (`mergeCountryPackConfig`), in case
  a later CountryPack version raises the floor after the override was
  written.
- **Tenancy of the two tables**: `CountryPack` has NO `tenantId` — it is
  global, system-owned reference data every tenant's branches resolve
  against, so (like `Tenant`/`TenantDomain`) it is NOT subject to RLS;
  `hrm_app` is granted `SELECT` only (writable today only via the owner
  role, i.e. seeding — a real admin-editable UI is later work, tracked in
  CLAUDE.md § Not yet built). `TenantCountryOverride` IS tenant-scoped —
  ordinary RLS applies, identical `tenant_isolation` policy pattern to
  every other tenant-owned table in this schema.
- **Reference packs — USA and Qatar** (`packages/db/src/
seed-country-packs.ts`, `seedCountryPacks()`, called by `prisma/seed.ts`;
  figures are illustrative/rounded for a reference implementation, not
  certified legal/tax guidance — a real deployment needs its packs
  authored/reviewed by whoever owns payroll compliance for that market):
  USD/Sat-Sun weekend/LTR English/4-layer tax (federal progressive
  brackets + a flat illustrative state rate + FICA social security with a
  wage-base cap + FICA medicare uncapped) + FUTA as an employer statutory
  component/`["SSN","W4"]` required, vs. QAR/Fri-Sat weekend/RTL Arabic/
  `tax.layers: []` (no income tax) + a tiered-by-years-of-service
  end-of-service gratuity as the statutory component/
  `["QATAR_ID","VISA_SPONSORSHIP"]` required — proving the identical
  schema and resolution/merge/rules-engine code drives opposite real
  behavior.
- **Demo endpoints** (`apps/api/src/country-packs/country-packs.controller.ts`):
  `GET /country-packs/effective?branchId=` (defaults to the caller's
  context branch) is this step's required proof endpoint; `GET
/country-packs/effective/:countryCode` resolves directly by country;
  `PUT /country-packs/overrides/:countryCode` is the write side of the
  two-layer model, deny-by-default behind a new permission,
  `country_pack.override.manage` (seeded onto `TENANT_ADMIN` via
  `ALL_PERMISSIONS` and explicitly onto `HR_MANAGER` — see
  `packages/shared/src/constants/permissions.ts`), same
  `@RequirePermissions()` + `PermissionsGuard`-as-interceptor pattern as
  the rest of RBAC (see [auth-rbac.md](./auth-rbac.md)). This route is
  also 0.9's reference usage for automatic audit capture — see
  [audit-custom-fields.md](./audit-custom-fields.md).
- Verified by `apps/api/src/country-packs/rules-engine/*.spec.ts` (unit:
  the evaluator's whitelist rejects out-of-whitelist nodes/operators/
  variables; `exprSchema` rejects the same independently; a real
  multi-layer US tax example and a real Qatar end-of-service example
  computed from the actual seeded pack data) and
  `apps/api/test/country-packs.e2e-spec.ts` (e2e over real HTTP: a US
  branch and a QA branch resolving opposite behavior through the same
  endpoint, the override layering over and being clamped/rejected against
  the pack's leave floor, an override payload naming a non-overridable
  section rejected, deny-by-default RBAC on the write route, and — the
  RLS proof — tenant A's override never leaking into tenant B's
  resolution of the same country).
