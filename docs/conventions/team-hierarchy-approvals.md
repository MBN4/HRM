# Team hierarchy approvals (step 7.2)

[← Back to CLAUDE.md](../../CLAUDE.md) · [Build log](../BUILD_LOG.md)

Defined in step 7.2 — `apps/api/src/workflow` (chain walker + engine rules),
`apps/api/src/users` (set-manager, hierarchy), `packages/db` (one additive
migration), `packages/shared`, `apps/portal`. **Builds on, does not rebuild,**
[workflow.md](./workflow.md) (the one approval engine),
[auth-rbac.md](./auth-rbac.md) (DB-backed RBAC) and
[user-management.md](./user-management.md) (the `/users` module).

## The model — one management chain

Every user has at most one manager: `User.managerId` (the self-relation added in
0.7, now the **explicit hierarchy** that the Team-access and Reporting-hierarchy
screens edit). A pre-7.2 tenant that only ever maintained the 1.1
`Employee.managerId` org chart keeps working: a user with **no** `User.managerId`
falls back to their Employee's manager (resolved to that manager's linked user).
If both exist, `User.managerId` wins.

```
intern ──► team lead ──► product manager ──► (no manager) ──► CEO
```

## Roles & authority (enforced exactly)

| Who                   | Rights                                                                                   | Approval authority                                                                 |
| --------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| **CEO**               | New system role, **all permissions** (like `TENANT_ADMIN`)                               | Can approve **any** request in the tenant; the fallback at the top of every chain. |
| **HR** (`HR_MANAGER`) | Full admin: users, employees, settings, leave balances, … (unchanged)                    | **Explicitly excluded** — never an approver, can never approve/reject/delegate.    |
| **Manager**           | Any user who has direct reports (the `MANAGER` role is just a default permission bundle) | Approves requests from the people who directly report to them.                     |
| **Member**            | Submits requests                                                                         | None; their requests route to their direct manager.                                |

The CEO role is seeded by `seedSystemRolesAndPermissions` for every new tenant,
and the 7.2 migration backfills it (mirroring `TENANT_ADMIN`'s grants) for every
existing tenant.

## Approver resolution — extending the existing `MANAGER` rule

No new rule kind, no per-module code. The 0.7 `MANAGER` approver rule now
resolves through `apps/api/src/workflow/approval-chain.ts`
(`resolveChainApprovers`), so **every** template step that uses `MANAGER`
(leave today; any future module) gets the hierarchy:

1. The requester's **direct manager**, if `ACTIVE` and not HR-excluded → `DIRECT_MANAGER`.
2. Otherwise (**deactivated / missing / HR**) the walk continues to **that
   manager's manager**, and so on → `ESCALATED_MANAGER_UNAVAILABLE`, with every
   skipped person recorded (`DEACTIVATED` / `HR_EXCLUDED` / `NOT_FOUND`).
3. Off the top of the chain (the org head has no manager) → the **active CEO(s)**
   → `CEO_TOP_OF_CHAIN` (or `CEO_ESCALATED` if anyone was skipped on the way).
4. No CEO available at all → active tenant admins as a last resort
   (`ADMIN_FALLBACK`); nobody → `NO_APPROVER` (the step stays `ACTIVE`, empty).
5. The requester is **never** their own approver at any level (a CEO's own
   request goes to another CEO, else an admin).

The chosen `routing` (`{kind, skipped[]}`) is persisted on the step
(`WorkflowInstanceStep.routing`, migration `20261008090000_add_workflow_step_routing`)
and is what the approvals inbox shows. It's a **pure walker over a tiny
`ChainReader`**: `DbChainReader` (tx-backed) for live resolution and a snapshot
reader inside `UsersService.hierarchy` for the org-chart "who approves this
person" preview — one algorithm, two readers, no drift. A depth cap + visited-set
makes it safe even if a cycle somehow existed in the data.

### Hard rules, enforced in the engine (server-side, not UI)

- **HR excluded** — two layers. (1) `ApproverResolverService.resolveDetailed`
  filters HR-excluded users out of the result of **every** rule kind (so even a
  `ROLE: HR_MANAGER` rule yields no approver). (2) `WorkflowEngineService.actOnStep`
  throws `403` if an HR-excluded user tries to approve/reject/delegate, and
  delegation _to_ HR (or to the requester) is a `400`. "HR-excluded" = holds
  `HR_MANAGER` and does **not** also hold `CEO`. HR's `LEAVE_APPROVE` _permission_
  is deliberately kept: in this codebase that permission gates leave
  **administration** (view anyone's leave, adjust balances), not deciding
  requests — deciding is the engine's job, and the engine refuses HR.
- **No self-approval** — `actOnStep` refuses approve/reject/delegate when
  `actor === instance.requesterId` (`403`), even for the CEO. Comments stay allowed.
- **CEO override** — a CEO may act on **any** `ACTIVE` step (except their own
  requests). The CEO's inbox lists those under `viewerReason: CEO_OVERRIDE`.
- Delegation/time-escalation (0.7) still _replace_ the approver as before and are
  honoured by re-routing (below).

### The chain changing under a pending request

`WorkflowRoutingService.rerouteActiveChainSteps` re-resolves every `ACTIVE`,
chain-routed step that hasn't been explicitly delegated/escalated, using the
same resolver. It runs inside the same transaction when a manager is
**deactivated**, **reactivated**, **reassigned** (`PATCH /users/:id/manager`) or a
user's **roles change** (HR/CEO eligibility). A changed step gets a new
`routing` and an `ESCALATE` `WorkflowAction` ("Re-routed after the management
chain changed: A → B") for audit. So: pending requests move immediately, future
ones resolve live at activation, and a returning manager takes theirs back.
(Cost note: it scans the tenant's active steps — the same "documented, not
silently accepted" tradeoff as `myPendingApprovals`; add an index/join table if
active-step volume ever warrants.)

## API surface (all `user.manage`, deny-by-default, audited, RLS-scoped)

| Route                                    | Purpose                                                                                                                |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `PATCH /users/:id/manager` `{managerId}` | Set/change/clear (`null`) who a user reports to. Audited as `User` / `SET_MANAGER`.                                    |
| `GET /users/hierarchy`                   | Every user (branch-scoped for restricted callers) with roles, manager, report count, **who approves them + why**.      |
| `POST /users` (`managerId?`)             | Optional manager at creation. `GET /users` items now carry `displayName`, `managerId`, `manager`, `directReportCount`. |
| `GET /workflow/my-pending-approvals`     | Items now carry `viewerReason` + `routing` (and the CEO also sees org-wide steps as `CEO_OVERRIDE`).                   |

**Set-manager guards** (the 7.1 philosophy): you can't change your own manager;
you must be able to manage the target (the 7.1 escalation guard — HR cannot
re-parent the CEO/admin); the manager must exist in this tenant (RLS) and be
`ACTIVE`; and **no cycles** — `wouldCreateCycle` walks up from the proposed
manager and rejects if it reaches the target (`400`, "reporting loop").

## Portal

- **`/hierarchy` (new, `user.manage`)** — "Reporting hierarchy": a collapsible visual
  tree (intern → lead → PM → CEO), search, expand/collapse all, per-person role
  badge (CEO / HR / Manager / Member / Admin), status, report count, and an
  "Approvals go to …" line that turns into a warning when a manager is
  unavailable. "Change manager" on every node.
- **`ManagerSelect`** — the searchable "Reports to" selector (styled `Select`),
  excludes the person and their own descendants (the server still validates).
  Used on `/hierarchy`, the Users page, Create user and Edit access.
- **`/users`** — new "Reports to" column, clearer role badges, a change-manager
  action; the deactivate confirmation now says reports' approvals escalate.
- **`/approvals`** — each request shows **why** it's in your queue (direct report /
  escalated — manager unavailable / top of chain → CEO / CEO override / delegated /
  overdue / assigned by role); your own items first, CEO-override items in their
  own section.
- Light/dark, en + ar, RTL via logical utilities, axe-checked.

## Honest gaps / decisions

- "Manager" is structural (has direct reports), not a role gate: any active,
  non-HR user in the chain can approve their reports' requests.
- Re-routing doesn't (yet) send a fresh notification to the newly eligible
  approver; they see it in their inbox. The `workflow.escalated` event is
  intentionally not re-emitted (the audit `ESCALATE` action records it).
- Modules that route **not** through the `MANAGER` rule (e.g. a `ROLE` rule) get
  the HR exclusion + no-self-approval + CEO override, but not the chain walk —
  by design (a role rule is "anyone with this role").
- Existing tests that used `HR_MANAGER` as an approver (`workflow.e2e-spec`'s
  second step, the recruitment offer approval, the expense large-amount step)
  were updated to a different approver role — that **is** the new rule.

## Verification

See the 7.2 entry in [BUILD_LOG.md](../BUILD_LOG.md).
