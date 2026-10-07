# Design system & branding — MBN (shared by `apps/portal` and `apps/admin`)

A visual-only pass (no business logic, API calls, auth, routing or i18n-key
meaning changed): one brand constant, one shared token palette, one Tailwind
preset, and a restyled `components/ui/*` kit — so the whole UI of **both**
apps changes from a handful of files. Supersedes the earlier per-app palettes
("grounded teal" in the portal, indigo in the vendor console) that
`frontend-ess-mss.md` / `vendor-console.md` describe.

## 1. The brand name — one line to rename

| What                                                                                   | Where                                                                                  |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| **`BRAND_NAME = 'MBN'`** (the single source of truth)                                  | `packages/shared/src/constants/branding.ts`                                            |
| `DEFAULT_PRODUCT_NAME` / `DEFAULT_EMAIL_FROM_NAME`                                     | same file — both derive from `BRAND_NAME`                                              |
| UI message catalog `app.name`, `branding.poweredBy`, `branding.productNamePlaceholder` | `packages/shared/src/i18n/messages.ts` — interpolate `BRAND_NAME` (en + ar)            |
| Per-app re-export + tab titles                                                         | `apps/{portal,admin}/src/lib/brand.ts` (`BRAND_NAME`, `PORTAL_TITLE`, `CONSOLE_TITLE`) |
| Portal runtime default                                                                 | `BrandingProvider`'s `DEFAULT_BRANDING.productName`                                    |

Renaming the product = edit `BRAND_NAME` and `pnpm --filter @hrm/shared build`.
A tenant's own `TenantBranding.productName` (white-label, 4.3) still overrides
it at runtime (`useBranding()`); the constant is the fallback.

Known leftovers deliberately NOT touched (not part of the two web apps / not
visual): `apps/mobile`'s own `BrandingContext`/`messages.ts` literals, the
tenant-MFA TOTP issuer default (`TENANT_MFA_ISSUER ?? 'HRM'` in the API), and
the `hrm` package/DB/infra names (an internal codename, not the product name).

### The lockup — `components/brand/Wordmark.tsx` (one copy per app)

`BrandMark` (an inline SVG "M" tile — no image dependency) + `Wordmark`
(mark + name, optional `suffix` such as "Vendor Console", `tone="light"` for
dark backdrops). Used on the login/forgot/reset screens and in both sidebars.
**White-label rule:** the MBN monogram renders only when the live product name
is the brand default; a tenant with an uploaded logo gets that `<img>`
(`data-testid="branding-logo"`), a tenant with its own name but no logo gets a
neutral initial tile (`branding-badge`) — never MBN's mark on someone else's
product. Test ids preserved: portal `branding-product-name`; admin uses
`brand-name` (so it can't collide with the Branding page's own ids).

## 2. Tokens — `packages/config/design-tokens.css`

Every color is a CSS variable holding a space-separated RGB triplet
(`--c-brand-600: 14 107 82`), so Tailwind opacity modifiers keep working
(`bg-brand-600/10`). `:root` holds light; `@media (prefers-color-scheme: dark)`
overrides them (the apps' existing `darkMode: 'media'`). **There is no
per-page `dark:` styling anywhere** — dark mode is a pure variable swap.

| Token family                | Role                                                                             | Anchors                                          |
| --------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------ |
| `brand-50…950`              | **Bottle-green primary**                                                         | 600 `#0e6b52`, 700 `#0b5d46`                     |
| `accent-50…900`             | **Sea-green accent** — focus ring, active-nav bar, highlights, selection         | 400 `#3fb890`, 500 `#2e9e7e`                     |
| `ink-50…950`                | Text + borders (slightly green-tinted neutrals)                                  | 900 body, 400 muted                              |
| `sand-50…500`               | Page background / hover surfaces                                                 | 50 page bg                                       |
| `amber` / `coral` / `sky`   | Semantic warning / danger / info (success = `brand`)                             |                                                  |
| `primary`, `primary-hover`  | **Solid fills that must stay dark under white text** (buttons, active admin nav) |                                                  |
| `danger`, `danger-hover`    | Destructive solid fills                                                          |                                                  |
| `surface`, `surface-raised` | Cards/inputs/modals (white ↔ raised near-black)                                  | replaces every `bg-white`                        |
| `sidebar`, `sidebar-fg`     | App-shell sidebar — `--c-sidebar` is set **per app** in its `globals.css`        | portal deep bottle green, admin near-black green |
| `chart-1…5`                 | Recharts series (`rgb(var(--c-chart-1))`)                                        |                                                  |
| `auth-base/top`, `glow-a/b` | Login backdrop — **deliberately non-flipping**                                   |                                                  |

**How dark works (read before adding a color):** the ramps are _flipped_, not
darkened — `ink-900` (body text) becomes near-white, `sand-50` near-black,
`brand-50/100` dark tints, `brand-700/800` light greens. So every existing
`text-ink-900 bg-sand-50` / `bg-brand-50 text-brand-700` pairing keeps its
contrast untouched. Consequences: (a) never use a flipping shade as a solid
fill under white text — use `bg-primary` / `bg-danger`; (b) never use a
flipping shade for something that must stay dark/light in both modes (the
modal scrim is `bg-sidebar/60`, the login backdrop uses `auth-*`, the
signature-pad canvas is a literal `bg-white`); (c) `bg-white` is banned in
app code — use `bg-surface`. Found+fixed during this pass: the first login
backdrop used `brand-950` and went pale in dark mode.

### Contrast (WCAG 2.1 AA — computed, not eyeballed)

| Pairing                                                                       | Ratio                   |
| ----------------------------------------------------------------------------- | ----------------------- |
| white on `primary` / on `danger`                                              | 6.47 / 5.71             |
| `ink-900` on `sand-50`                                                        | 16.7                    |
| `ink-400` (muted text) on white / on `sand-50`                                | 5.19 / 4.85             |
| `brand-700` on `brand-50` (success badge)                                     | 7.18                    |
| `amber-600` on `amber-50` / `coral-600` on `coral-50` / `sky-700` on `sky-50` | 5.37 / 5.34 / 7.29      |
| `sidebar-fg` on portal / admin sidebar                                        | 8.46 / 12.53            |
| `accent-500` focus ring on white (non-text, ≥3)                               | 3.33                    |
| Dark: `ink-900`/`ink-400`/white-on-`primary`/white-on-`danger`                | 17.2 / 6.8 / 5.3 / 4.75 |
| Dark: `brand-700`/`amber-600`/`coral-600`/`sky-700` on their `-50` tints      | 8.8 / 9.5 / 7.5 / 10.3  |

## 3. The Tailwind preset — `packages/config/tailwind-preset.js`

Both apps' `tailwind.config.ts` are now ~5 lines: `presets: [require('@hrm/config/tailwind-preset')]`

- `content`. The preset maps every token to `rgb(var(--c-…) / <alpha-value>)`,
  defines fonts/radius/shadows (`shadow-card`/`soft`/`pop`), and a tiny plugin
  (plain `{ handler }` object — no `tailwindcss` dependency in `packages/config`,
  pnpm wouldn't resolve one) that adds the base + component layer:

* **Base:** body bg/color/line-height, `[dir=rtl]` font + looser line-height,
  heading letter-spacing (zeroed in RTL), the global `:focus-visible` ring
  (2px gap + 2px `accent-500`), `::selection`, checkbox/radio `accent-color`, and
  **all tables** — header (`thead th`: small uppercase tracking, muted) and row
  hover — because the apps have ~40 plain `<table>`s and no shared `<Table>`.
  (Uppercase/tracking are switched off under RTL — Arabic has no case.)
* **Components:** `.page-title` (1.5rem/650/-0.02em; every `<h1>`), `.page-subtitle`,
  `.eyebrow` (nav-group / label caps), `.auth-backdrop` (deep-green scene,
  two radial glows + masked grid), `.auth-card`.

Each app's `globals.css` is: `@import '@hrm/config/design-tokens.css'` (plain
CSS, so Tailwind processing isn't needed on the imported file), the three
`@tailwind` directives, and `--c-sidebar`. **After editing the preset, restart
`next dev` and clear `.next`** — Tailwind caches the required preset module.

## 4. Typography, spacing, surfaces

- **Fonts:** Inter via `next/font` in both apps (`--font-inter`); the portal adds
  Noto Kufi Arabic for RTL. System stack fallbacks. No other font dependency.
- **Scale:** page title 1.5rem; card title `text-sm font-semibold`; body `text-sm`;
  `eyebrow` 0.6875rem caps. Auth titles `text-xl`.
- **Layout:** shell `max-w-[88rem]` content, `p-6 lg:p-8`; `space-y-6` between
  sections; sticky full-height sidebar + sticky translucent top bar.
- **Cards:** `rounded-xl2` (1rem) + 1px `ink-100` border + `shadow-card`;
  popovers/modals `shadow-pop`.
- **RTL:** unchanged discipline — logical utilities only (`start-0`, `border-e`,
  `ms-/me-`); the new active-nav accent bar is `start-0` so it mirrors.

## 5. Component kit (`components/ui/*`, identical API in both apps)

`Button` (primary/secondary/ghost/danger, `bg-primary`/`bg-danger`, `disabled:opacity-50`
instead of a lighter shade so it works in dark), `Card*`, `Badge`/`StatusBadge`
(status pills now `ring-1 ring-inset` tinted), `Input`/`Textarea`/`Select`/`Label`
(`focus:border-accent-500`), `PasswordInput` (show/hide kept), `Alert`, `Modal`
(blurred `sidebar` scrim), `EmptyState` (icon in a tinted disc), `Spinner`.
There is no toast component in either app (feedback is inline `Alert`) — none added.
Adding a status? Extend `STATUS_TONE` in `Badge.tsx` as before — tones, not colors.

## 6. Verification performed (see BUILD_LOG)

Production builds of both apps; both Playwright suites (incl. the axe-core
accessibility specs, which run against the new palette); and a screenshot
review of login + dashboard + several admin/list pages in light/dark ×
LTR/RTL for both apps. **RTL caveat for the portal:** layout direction comes
from the resolved Country Pack's `locale.rtl` (1.4), not the language toggle —
a US-branch user switched to Arabic gets Arabic text in an LTR layout _by
design_; the RTL screenshots use a Qatar-branch user.

## 7. Theme toggle (light / dark / system)

`ThemeToggle` (a 3-way radiogroup in each app's top bar) + `ThemeProvider`
(`lib/theme/`, identical copy per app) write `data-theme="light|dark"` on
`<html>` and persist to `localStorage['mbn.theme']`; **"system" removes the
attribute** and the tokens' `prefers-color-scheme` block decides (first-visit
default). `design-tokens.css` therefore has the dark ramp **twice, kept
identical**: `@media (prefers-color-scheme: dark) { :root:not([data-theme='light']) {…} }`
and `:root[data-theme='dark'] {…}` — edit both. A tiny inline `<head>` script
(`THEME_INIT_SCRIPT`) applies the stored choice before first paint (no
flash); `<html>` carries `suppressHydrationWarning` for it. The Tailwind
`darkMode` is `['selector', "[data-theme='dark']"]` but nothing uses `dark:`
(dark is a pure variable swap) — it only keeps any future `dark:` honest.

## 8. Dropdown / Select pattern

`components/ui/Select.tsx` (re-exported from `Field.tsx`, so every
`import { Select } from '…/ui/Field'` keeps working — ~60 call sites changed
by zero lines). It is a styled **combobox + portalled listbox** (fixed-position,
flips up near the viewport bottom, can't be clipped by a Modal), with search
above 8 options, arrow/Home/End/Enter/Esc/type-ahead, `optgroup`s, and
logical (start/end) layout so it mirrors under RTL. **Compatibility trick:** it
keeps a real, visually-hidden, `aria-hidden`, tab-skipped `<select>` beside the
trigger and, on choose, sets its value and dispatches a genuine `change`
event — so callers' `onChange(e.target.value)`, native `required` validation,
`<label for>` and Playwright's `selectOption` all work unchanged. (Consequence:
`getByLabel('X')` now also matches the trigger's aria-label — scope with
`page.locator('select').and(page.getByLabel('X'))`, as admin's tenants spec
does.) Escape is swallowed in the capture phase so it never closes an
enclosing Modal.

Other kit pieces added/fixed in the same pass: `Tabs` (WAI-ARIA tablist,
RTL-aware arrows — the Recruitment tab strip now uses it), `SegmentedControl`
(range presets), `Pagination`, `Tooltip`; base styles in the preset for native
file inputs (`::file-selector-button`), date/time pickers, `textarea`, and
themed scrollbars. Not built: a multi-select (no screen needs one today).

## 9. Charts (`components/charts/index.tsx`, identical copy per app)

Recharts (already a portal dependency; added to admin). One kit, no per-chart
theming: series colors are `--c-chart-1…5` then `brand-400`/`ink-400`
(`seriesColor(i)`); tooltips/legends are plain Tailwind HTML passed as
Recharts `content`; **never put a raw color at a call site**. Pieces: `KpiCard`
(+ `TrendPill`, `Sparkline`), `ChartCard` (title, skeleton while loading,
dashed empty state), `TrendAreaChart`, `BarBreakdown` (vertical/horizontal,
stacked), `DonutChart` (hover-linked legend, centre total), `topN`
(collapse the tail to "Other"). Legends are click-to-toggle. **RTL:** the SVG
wrapper is forced `dir="ltr"` and RTL is expressed by `reversed` X axes and
right-hand Y axes; **Recharts' draw animation renders nothing on a reversed
axis, so `isAnimationActive={!rtl}`** (found by screenshotting the Qatar user).

**Dashboards.** Portal `/analytics`: branch Select + 7/30/90/custom range
refetch `/analytics/dashboard`; every KPI shows a trend vs the previous
equal-length period (a second read of the same precomputed-rollup endpoint,
never a live aggregate); rate KPIs show percentage-point deltas, and "good"
direction is per-KPI (fewer leavers is green). Empty state offers a one-click
`POST /analytics/rollup/run`. Portal `/dashboard`: leave-balance bars + (for
`analytics.read`) a workforce snapshot. Admin `/dashboard`: tenants by
status/edition, tenant growth, seat usage (≤8 tenants), subscription status,
audit activity + recent events, upcoming renewals — all existing `/platform/*`
endpoints; the 7/14/30-day window filters client-side (the audit endpoint has
no date filter). **Known gap:** no department chart/filter — the rollup returns
department _ids_ and no endpoint lists department names; adding one is an API
change this pass deliberately avoided.

## 10. Demo data (dev-only)

```
pnpm --filter @hrm/db run seed                  # real seed (once)
pnpm --filter @hrm/api run seed:demo            # ~72 employees, 100d attendance, leave, payroll, benefits, 5 extra tenants
pnpm --filter @hrm/api run demo:rollup [days]   # API must be running; fills the 4 rollup tables (default 65 days)
```

`apps/api/scripts/seed-demo-data.ts` refuses `NODE_ENV=production`, only
touches `acme-demo` plus `demo-*` tenants, and is idempotent (natural keys /
`[demo]`-marked rows, fixed-seed PRNG). Payroll lines are **fabricated**, not
engine output. Logins (password `DemoPass-123!`): `demo.us@acme-demo.local`
(US branch, LTR) and `demo.qa@acme-demo.local` (Doha branch → Qatar pack →
real RTL Arabic). Re-run `demo:rollup` daily if you want "yesterday" populated
(the scheduled job also does this on a running worker).

## 11. Sidebar (step 7.3) — `packages/ui` (`@hrm/ui`)

ONE sidebar component for both apps, in the repo's first shared React package
(source-only, consumed via Next's `transpilePackages: ['@hrm/shared','@hrm/ui']`
and scanned by each app's Tailwind `content` glob). `apps/portal` and
`apps/admin` only supply **data** (nav groups/items, labels, brand lockup);
their items, order and RBAC/owner-only gating are unchanged.

- **API**: `<SidebarProvider storageKey>` (per-app persisted state) wraps the
  shell; `<AppSidebar variant="portal"|"admin" groups footerItems labels brand caption/>`;
  `<SidebarMobileTrigger label/>` goes in each Topbar. Every string is passed in
  (portal: `sidebar.*` en+ar catalog keys; admin: English, like the rest of its chrome).
  `variant="portal"` = soft pill + accent bar; `"admin"` = solid `primary` pill.
- **Collapse to rail**: toggle in the footer (`aria-expanded`, label flips
  Collapse/Expand). Rail = 72px, icons only (labels stay in the DOM, so they remain the
  link's accessible name). Labels fade + collapse (`opacity`/`max-width`/`margin`
  transition) rather than snap. `RailTooltip` shows the label on hover **and keyboard
  focus**; it is portalled + `position: fixed` (the nav is `overflow-y: auto` and would
  clip it) and opens toward the content.
- **Drag to resize**: a `role="separator"` handle on the **inline-end (inner) edge**.
  Range **224–360px** (default **264**); releasing below the rail/min midpoint snaps to
  the rail, dragging a rail outward re-expands it. Keyboard: Arrow keys ±16px, Enter/
  double-click toggles. Pointer capture on the handle; no transition while dragging.
- **Persistence**: `localStorage` `mbn.portal.sidebar.v1` / `mbn.admin.sidebar.v1` =
  `{"collapsed":bool,"width":px}`. Read after mount (never during SSR), all access
  try/catch'd (blocked storage ⇒ defaults), width clamped on read. `data-ready` flips
  after the read and transitions are enabled only then, so a reload never animates.
- **RTL (the risky part)**: only logical utilities (`start-/end-`, `ms-`, `-end-1.5`) for
  layout; the sidebar is the first flex child so `dir=rtl` puts it on the right and the
  handle (`end`) on its LEFT edge. Drag math can't use logical CSS, so it reads
  `getComputedStyle(aside).direction` and measures from the right edge in RTL; Arrow
  keys are mirrored the same way; chevrons use `rtl:rotate-180`; the tooltip picks
  `right:` vs `left:` from the anchor's computed direction and uses an `-rtl` keyframe.
- **Animation**: one easing (`cubic-bezier(0.22,1,0.36,1)`), 260ms width / 220ms labels,
  applied ONLY through `motion-safe:` classes — `prefers-reduced-motion` gets
  `transition-duration: 0s` (asserted by a test).
- **Small screens (<1024px)**: no rail — a fixed overlay drawer (translate off-canvas,
  `invisible` when closed so it leaves the tab order), backdrop, Esc / backdrop / route
  change closes it, opened by the Topbar hamburger. The desktop collapsed preference is
  ignored there (labels always shown).
- **Brand**: `Wordmark` gained `markOnly` (rail shows just the mark/logo tile).
- **Not in the sidebar**: the theme toggle and account menu stay in the Topbar (moving
  them would duplicate `data-testid`s and change established flows); they are unaffected
  by collapse. A tooltip-per-footer-item and an in-sidebar account chip are easy
  `footerSlot` additions if wanted.
- Tests: `apps/portal/tests/sidebar.spec.ts` (collapse/persist/tooltip, drag bounds +
  snap + persist, keyboard handle, active state, reduced motion, mobile drawer, RTL
  geometry + mirrored keys/tooltip, axe light/dark × expanded/collapsed × LTR/RTL) and
  `apps/admin/tests/sidebar.spec.ts`.
