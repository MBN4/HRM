# Pakistan country pack

[← Back to CLAUDE.md](../../CLAUDE.md) · [Build log](../BUILD_LOG.md)

Defined in step 3.5.5 — `packages/db/src/seed-country-packs.ts` (`PAKISTAN_PACK`),
`apps/api/test/country-packs.e2e-spec.ts`, `apps/api/test/benefits.e2e-spec.ts`.
This is AUTHORING work on top of the existing, unmodified Country Pack schema
and rules engine — see [country-packs.md](./country-packs.md) for the schema/
override/evaluator write-up (not repeated here) and [payroll.md](./payroll.md)
(the engine that consumes this pack) / [benefits.md](./benefits.md) (where
Pakistan first appeared, as an ad-hoc test fixture — see below). **Zero
changes to the engine, the schema, or the evaluator** — this step is entirely
"what data does a real Pakistan pack contain," proving the schema is
expressive enough for a genuine third market without a single code change
anywhere in `apps/api/src/country-packs`, `apps/api/src/payroll`, or
`packages/shared/src/validators`.

## Why this step exists — replacing an ad-hoc test fixture with a real pack

Step 3.5.2 (Benefits administration) needed a THIRD country (beyond the
shipped US/QA reference packs) to prove `computeStatutoryComponent` handles
a genuinely different scheme with zero engine change — see
[benefits.md](./benefits.md) § Statutory schemes. It created a minimal,
ad-hoc "Pakistan-style" pack DIRECTLY inside `benefits.e2e-spec.ts`
(1%/5% EOBI-style percentages, no tax, no required fields, no real holiday
calendar) — explicitly documented at the time as a proof-of-concept, never
added to `seed-country-packs.ts`. This step replaces that fixture with a
REAL, production-shaped Pakistan pack, seeded exactly like US/QA, and
updates the two test files that referenced the ad-hoc version
(`benefits.e2e-spec.ts`'s statutory-schemes proof, and adds Pakistan to
`country-packs.e2e-spec.ts`'s own core "same code path, divergent behavior"
proof, which previously only contrasted US vs. QA).

## THE COMPLIANCE BOUNDARY — read this before using this pack for a real client

> This pack's STRUCTURE is production-ready: the right shape of tax
> brackets, wage-ceiling-based statutory contributions, required onboarding
> fields, and payslip layout for a Pakistan-based branch. Every
> LEGALLY-SENSITIVE NUMBER in it — income tax slab thresholds/rates, EOBI
> contribution rates and wage ceiling, Provident Fund rates — is a
> PLACEHOLDER, shaped like real Pakistani payroll law so the FORMULA is
> correct, but NOT verified against a current FBR notification, EOBI
> gazette, or a specific employer's PF trust deed. **A qualified Pakistani
> tax/payroll professional MUST review and confirm every such figure
> against the current Finance Act / FBR withholding tables / EOBI Act (as
> amended) / the client's own PF scheme before this pack is used to run
> real payroll.** This is exactly [payroll.md](./payroll.md)'s/
> [benefits.md](./benefits.md)'s own "the engine computes exactly what the
> pack says; legal correctness is an authoring responsibility" boundary,
> made concrete for a real engagement — not a new rule, the SAME one applied
> more emphatically because this pack is intended as a real starting point,
> not only a reference/demo like US/QA.

Every legally-sensitive field in `PAKISTAN_PACK` (`packages/db/src/seed-country-packs.ts`)
carries its own inline `// VERIFY: ...` comment naming exactly what needs
confirming and against what source (FBR, EOBI, the client's own PF trust
deed) — the same discipline this file's own top banner comment states
prominently before the pack definition even starts. This is a stronger,
more explicit version of the "illustrative, not certified" disclaimer the
US/QA reference packs already carry (see [country-packs.md](./country-packs.md)):
those two exist purely to prove genericity; this one is meant to be a real
client's actual starting point, so its placeholders are called out far more
insistently.

## What's in the pack

- **Locale — PKR, Urdu, RTL.** `currencyCode: 'PKR'`, `dateFormat: 'DD/MM/YYYY'`.
  `defaultLanguage: 'ur'` / `rtl: true` — a DELIBERATE choice, not the
  simpler `'en'`/`false`: Urdu is already in `@hrm/shared`'s `RTL_LANGUAGES`
  whitelist (`packages/shared/src/i18n/rtl.ts`, since it was added
  proactively, unused until now) but no pack had ever actually SET
  `locale.rtl: true` with a non-Arabic language before this step — this pack
  is what proves the i18n framework's RTL wiring generalizes beyond Qatar's
  Arabic, using the SAME `locale.rtl`-is-authoritative mechanism
  [i18n-timezone-rtl.md](./i18n-timezone-rtl.md) documents, zero code
  changes. `firstDayOfWeek: 'MONDAY'` — a genuinely different choice from
  BOTH existing reference packs (which use `SUNDAY` regardless of their own
  weekend), matching Pakistan's actual Monday-start work week and proving
  this field is real per-pack data.
- **Working time — the common Pakistani Sat/Sun weekend.**
  `weekendDays: ['SATURDAY', 'SUNDAY']`, `standardWeeklyHours: 40`. A client
  whose actual work week differs (a factory on a different rotation, a
  different provincial ordinance) sets this via the EXISTING tenant
  `workingTime` override (see [country-packs.md](./country-packs.md)'s
  two-layer model) — no pack change needed for that case, exactly the same
  seam every tenant already has for US/QA. `overtimeRules.multiplier: 2.0`
  (VERIFY-flagged) — commonly-cited Factories Act double-rate, a genuinely
  different multiplier from both the US pack (1.5x) and Qatar's (1.25x),
  again proving real per-pack divergence, not a copy-pasted default.
- **Public holidays — fixed-date national holidays seeded for real, lunar
  holidays seeded as explicit yearly-reconfirmation placeholders.** Six
  fixed-date 2026 holidays (Kashmir Solidarity Day, Pakistan Day, Labour
  Day, Independence Day, Iqbal Day, Quaid-e-Azam Day) need no yearly
  maintenance — their calendar dates don't move. Four lunar/Hijri-calendar
  holidays (Eid-ul-Fitr, Eid-ul-Adha, Ashura, Eid Milad-un-Nabi) DO move
  every year and are only ever officially confirmed a few days ahead by
  moon-sighting — `publicHolidaySchema` requires a concrete `date` (no
  "TBD" value is expressible in the existing, unmodified schema), so these
  four are seeded with ASTRONOMICALLY-PROJECTED 2026 dates and a
  `"(VERIFY — approx., confirm via moon-sighting/govt. notification)"`
  suffix baked directly into the `name` field itself — the one schema field
  available to carry this warning through to anyone reading the resolved
  pack (e.g. via `GET /country-packs/effective`), not just a source-file
  comment. **A genuine, recurring operational task, not a one-time fix**:
  these four MUST be corrected to the real gazette-notified date every
  single year, the moment it's announced — this is the honest, structural
  reason "lunar holiday" is a fundamentally different maintenance category
  from "fixed holiday" for this market, not a gap this step could close
  with better data.
- **Tax — a single progressive federal layer.** `income_tax`
  (`PROGRESSIVE_BRACKETS`, `base: 'annualSalary'`) — the SAME generic
  algorithm the US pack's `federal_income_tax` layer already uses (zero
  engine change), six illustrative VERIFY-placeholder bands. Unlike the US
  pack, there is no second "state-equivalent" income tax layer — Pakistan's
  provincial variation is NOT expressed as a separate income-tax layer
  (there isn't one in Pakistani law), so this pack has only ONE tax layer,
  itself a real structural divergence from the US pack proving `tax.layers`
  genuinely varies in SHAPE (count), not just in numbers, across packs.
- **Statutory — EOBI (wage-ceiling-based) + Provident Fund, four
  components.** `eobi_employee`/`eobi_employer` — `PERCENTAGE` of
  `basicSalary` with a monthly `cap` (the wage ceiling) — the SAME
  `PERCENTAGE`-plus-`cap` shape the US pack's own FICA social-security layer
  already uses for ITS wage-base cap (`computeStatutoryComponent`'s
  existing `min(base, cap) * rate` needed no change to support this).
  `provident_fund_employee`/`provident_fund_employer` — `PERCENTAGE` of
  `basicSalary`, uncapped, the same two-component "each side may differ"
  shape the Qatar pack's GRSIA pension already established (see
  [benefits.md](./benefits.md)) — modeled symmetric here (both illustrative
  placeholders happen to be the same rate), but structurally free to diverge
  the moment a real client's PF trust deed says otherwise, with no schema
  change. Rates preserve continuity with the ad-hoc 3.5.2 fixture's own
  numbers (1% employee / 5% employer EOBI) while ADDING the wage ceiling
  that fixture never had — a genuine structural improvement, not just a
  copy.
- **Required employee fields — CNIC + NTN.** `['CNIC', 'NTN']` — CNIC
  (NADRA's Computerized National Identity Card) is Pakistan's direct
  equivalent of the US pack's `SSN` / the Qatar pack's `QATAR_ID`; NTN
  (FBR's National Tax Number) mirrors the US pack's `W4` slot — a
  tax-related identifier captured at onboarding. Both are OPAQUE keys to
  this schema (see [country-packs.md](./country-packs.md) — meaning lives
  in the employee-fields module, [employee.md](./employee.md)) — `EmployeeService`'s
  existing, unmodified required-field validation enforces them for a PK
  branch with ZERO new code, the identical mechanism already proven for
  US/QA.
- **Payslip template — Urdu labels, matching `locale.defaultLanguage`.**
  `language: 'ur'`, six line items (`basic`/`gross`/`income_tax`/
  `eobi_employee`/`provident_fund_employee`/`net`) — deliberately omits the
  EMPLOYER-only components (`eobi_employer`/`provident_fund_employer`), the
  SAME "a payslip shows what was deducted from the EMPLOYEE, not the
  employer's own cost" posture the US pack's template already takes
  (`futa`, employer-only, is likewise absent from its template).
- **`payrollMode: 'CALCULATE'`** — Pakistan's statutory scheme is tractable
  for the in-house engine, same as both existing reference packs; no
  `DELEGATE`-mode external-provider need demonstrated by this pack.
- **`hostingRegionHint: 'me-south-1'`** — advisory only, per this field's
  own schema doc (never a hard residency guarantee); no dedicated major
  cloud region serves Pakistan directly, so the nearest already-used
  regional hint in this codebase is reused. **Flagged for Phase 6.1, not
  implemented here**: some Pakistani sectors (banking/telecom, under State
  Bank of Pakistan / PTA rules) have real data-localization requirements a
  future data-residency feature would need to enforce properly — this pack
  only carries the advisory hint, exactly as the schema already documents
  for every pack.

## What changed in the test suites, and why

- **`apps/api/test/country-packs.e2e-spec.ts`** — a THIRD branch
  (`branchAPkId`, `countryCode: 'PK'`) added to the existing "same code
  path, divergent behavior driven entirely by data" `describe` block
  alongside the pre-existing US/QA branches, with a new test asserting
  PKR/Sat-Sun/RTL-Urdu/the real `income_tax` tax layer/all four statutory
  components/`CNIC`+`NTN` required — through the EXACT same
  `GET /country-packs/effective` endpoint the US/QA tests already use, zero
  new routes or fixtures beyond the one new branch.
- **`apps/api/test/benefits.e2e-spec.ts`** — the ad-hoc `PK_PACK_CONFIG`
  constant and its direct `prisma.countryPack.create` call are REMOVED;
  `seedCountryPacks(prisma)` (already called in this file's `beforeAll`)
  now seeds the real Pakistan pack too, so `branchPkId` (unchanged) simply
  resolves against it. The "statutory schemes differ by country" test's
  expected component-name list grows from `['eobi_employee',
'eobi_employer']` to all four real components; the payroll-run test is
  rewritten to hand-compute (from the REAL pack's own declared rates/
  brackets/cap — see the test's own inline comments) the correct
  `income_tax` + `eobi_employee`/`_employer` + `provident_fund_employee`/
  `_employer` breakdown for a real run, explicitly proving the WIRING (the
  unmodified engine correctly reads and applies the pack's data), not
  asserting any figure is legally correct — the test would need to change
  the moment the pack's own VERIFY placeholders are replaced with real,
  verified numbers, which is the point: the pack is the single source of
  truth for what the engine computes.
- `resetFixtures()` in `benefits.e2e-spec.ts` no longer deletes the `PK`
  `CountryPack` row — it's now a real, permanent seeded reference pack, the
  same "never deleted by any test's fixture reset" treatment US/QA already
  get.

## Known, documented gaps for this phase

Every VERIFY-flagged figure (see above) is, by definition, not yet
confirmed against current law/a specific client's scheme — this is the
step's own explicit, central scope boundary, not an oversight. Lunar
holidays need real annual reconfirmation (a structural, recurring
operational task — see above), not a one-time data fix. No PK-specific
`DELEGATE`-mode adapter is implied or built (the pack ships `CALCULATE`
only, matching both existing reference packs). Provincial variation
(Sindh/Punjab/KPK/Balochistan/Islamabad each have their own Shops &
Establishments Ordinance) is NOT modeled as anything more granular than one
national pack — a future need for genuine PROVINCE-level divergence within
Pakistan would need a new modeling decision (e.g. per-province tenant
overrides layered on this pack), not attempted here, the same "not required
by this step's own scope" posture every other documented gap in this
codebase takes.

Verified: `PAKISTAN_PACK` parses cleanly against the existing, unmodified
`countryPackConfigSchema` (`countryPackConfigSchema.parse` — same
validate-before-write discipline `seedCountryPacks` already holds itself
to for every pack). `apps/api/test/country-packs.e2e-spec.ts` (10 tests,
one new: the PK divergence proof) and `apps/api/test/benefits.e2e-spec.ts`
(14 tests, two rewritten: the statutory-schemes-differ proof and the real
payroll-run proof) both green, alongside every other existing US/QA-driven
test in both files, completely unmodified — proving this step changed
nothing about how the two existing reference packs behave. Full `apps/api`
suite (529 tests) + `packages/db` suite (37 tests) run `--runInBand`: zero
regressions from this step; the one full-suite failure
(`migration.e2e-spec.ts`, 2 tests) is the SAME pre-existing timing flake
this suite already carries (see docs/conventions/scaling-data-layer.md's
5.1 entry) — that file never touches country packs/payroll/benefits at
all, and passes 10/10 cleanly in an isolated rerun. Full-repo `pnpm build`/
`pnpm lint` green across all workspace tasks.
