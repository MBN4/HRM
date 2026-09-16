# Security checklist — SaaS operators and on-prem/self-host customers

[← Back to CLAUDE.md](../CLAUDE.md) · [Build log](./BUILD_LOG.md) ·
[Security hardening convention](./conventions/security-hardening.md)

HRM ships as one codebase under two delivery models (CLAUDE.md §1): vendor-
hosted multi-tenant SaaS, and a lifetime on-prem license where a customer
runs the SAME codebase on their own infrastructure. This checklist is for
BOTH — items marked **(on-prem only)** apply specifically to a customer
standing up their own deployment; everything else applies to any running
instance, SaaS or on-prem.

Every item states whether it's already true of the codebase as shipped
("built-in"), or an operational step the deploying party must actually do
("operator action") — mirroring the "verified-locally vs. verify at deploy"
honesty this repo already holds itself to elsewhere (see
[deployment-scaling.md](./conventions/deployment-scaling.md),
[observability-load.md](./conventions/observability-load.md)).

## 1. Secrets

| Item                                                                                                                                            | Status                                                                                                                                                                                            |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FIELD_ENCRYPTION_KEY`, `JWT_SECRET`, `JWT_REFRESH_SECRET`, `PLATFORM_JWT_SECRET`, `BACKUP_ENCRYPTION_KEY` are all env-sourced, never hardcoded | Built-in                                                                                                                                                                                          |
| Every one of the above is rotated away from the checked-in local-dev default before going live                                                  | **Operator action** — the repo's own dev defaults (e.g. `change_me_dev_secret`) are plaintext on purpose, documented as local-dev-only (see `apps/api/.env.example`)                              |
| Field-encryption key rotation is supported without breaking existing encrypted data (§1.2 of security-hardening.md)                             | Built-in — exercise it via `FIELD_ENCRYPTION_KEY_VERSION`/`FIELD_ENCRYPTION_PREVIOUS_KEYS`                                                                                                        |
| A real secrets manager (AWS Secrets Manager/Vault) instead of plain env vars                                                                    | **Operator action** — `SECRETS_PROVIDER`/`CloudSecretsProvider` is a documented seam, not a working integration in this environment; implement the one class described in that file's doc comment |

## 2. Network + transport

| Item                                                                                                   | Status                                                                                                                |
| ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| TLS termination in front of the API                                                                    | **Operator action** — this process speaks plain HTTP; terminate TLS at your load balancer/ingress (see `deploy/k8s/`) |
| `CORS_ADDITIONAL_ORIGINS`/`TENANT_BASE_DOMAIN` reflect your REAL deployed origins, not local dev ports | **Operator action**                                                                                                   |
| Secure headers (HSTS/CSP/X-Frame-Options)                                                              | Built-in (`configureSecurity`, helmet)                                                                                |
| A WAF / DDoS layer in front of the API                                                                 | **Not yet built** — flagged as step 6.3, explicitly out of this step's scope                                          |

## 3. Authentication + authorization

| Item                                                                           | Status                                                                                                                                          |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Argon2id password hashing                                                      | Built-in                                                                                                                                        |
| Refresh-token rotation + reuse detection                                       | Built-in                                                                                                                                        |
| Per-`{tenant,email}` login/refresh/reset rate limiting, non-enumerating errors | Built-in                                                                                                                                        |
| Mandatory MFA for every platform (vendor super-admin) account                  | Built-in, enforced — cannot be disabled                                                                                                         |
| Optional MFA for tenant users                                                  | Built-in — **(operator/tenant-admin action)** to actually encourage/require enrollment via your own org policy; this codebase does not force it |
| RBAC roles/permissions reviewed for least privilege per tenant                 | **Operator action** — `TENANT_ADMIN`/`HR_MANAGER`/`MANAGER`/`EMPLOYEE` are SEED defaults only; a tenant can and should tailor its own roles     |

## 4. Data protection

| Item                                                                  | Status                                                                       |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Row-Level Security enforced in Postgres for every tenant-scoped table | Built-in, DB-enforced — see [tenancy-rls.md](./conventions/tenancy-rls.md)   |
| Employee bank/salary fields encrypted at rest                         | Built-in — see [employee.md](./conventions/employee.md)                      |
| `hrm_app`'s default local password rotated                            | **Operator action (non-local deployments)** — see tenancy-rls.md's own note  |
| `audit_log` DB-level immutable (`REVOKE UPDATE/DELETE`)               | Built-in, proven to survive partitioning (5.2) and a real restore (§3 below) |

## 5. Backups + disaster recovery

| Item                                                   | Status                                                                                                                                                                                    |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Automated, encrypted Postgres + object-storage backups | Built-in mechanism (`ops/backup/`) — **(operator action)** to actually schedule it (cron/CronJob — see `ops/backup/DR-RUNBOOK.md`)                                                        |
| A tested restore procedure                             | Built-in + proven locally (`ops/backup/restore-drill.sh`, run twice, fully green) — **(operator action)** to re-run the drill periodically against YOUR real backups                      |
| Backups stay in-region (residency)                     | **Operator action** — point backup storage at a bucket/volume in the same `DEPLOYMENT_REGION` as the source; cross-region replication is a documented seam, not enforced by these scripts |
| A real cloud KMS holding `BACKUP_ENCRYPTION_KEY`       | **Operator action (on-prem only, and recommended for SaaS)** — see DR-RUNBOOK.md's verified-at-deploy list                                                                                |

## 6. CI / supply chain

| Item                                                            | Status                                                                                                                                                                                       |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Build/lint/test runs on every PR                                | Built-in (`.github/workflows/ci.yml`)                                                                                                                                                        |
| Dependency vulnerability scanning                               | Built-in, INFORMATIONAL (`pnpm audit`, not yet a hard gate — see security-hardening.md §1.9)                                                                                                 |
| Secret scanning of the repo/PR diff                             | Built-in (`gitleaks`)                                                                                                                                                                        |
| A private, first-party npm registry / dependency pinning policy | **(on-prem only) Operator action** — this repo pins exact versions in its lockfile; a customer building their own images should mirror/vendor dependencies per their own supply-chain policy |

## 7. On-prem/self-host specific

**(on-prem only)** — the lifetime-license delivery model runs the identical
codebase, so everything above applies unchanged; these items are additional
because an on-prem customer, not the vendor, now owns the infrastructure:

- Rotate EVERY checked-in local-dev credential (`docker-compose.yml`'s
  Postgres/Redis/MinIO passwords included) before exposing the deployment
  to real traffic.
- Decide your OWN `DEPLOYMENT_REGION`/data-residency posture — see
  [privacy-residency.md](./conventions/privacy-residency.md).
- Run the restore drill (§5) against YOUR infrastructure once, before
  go-live, not just trust that it worked in the vendor's own sandbox.
- Confirm your own network perimeter (firewall/security-group rules)
  restricts direct database/Redis/MinIO access to the application tier
  only — none of those are meant to be internet-reachable.
- License-file handling (`LICENSE_PRIVATE_KEY_PATH`) — the PRIVATE signing
  key must never ship in an on-prem build; only the PUBLIC verification key
  is needed to run (see `apps/api/keys/README.md`).
