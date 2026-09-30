# Production Decision Checklist

> **These decisions must be supplied by the business, legal counsel or the system owner before any production enablement.**
> The system does not choose any of these values. Until a decision is recorded, the system refuses: it does not guess.
> Tick a box only when a written decision exists. Record who decided and when.

Status legend: ☐ open · ☑ decided (record reference).

The "Until decided" column says what the system does today when the value is missing. The "Where it goes" column says where the value is configured once decided.

---

## 1. Supabase

| ☐ | ID | Decision | Why it matters | Until decided | Where it goes |
|---|---|---|---|---|---|
| ☐ | SB-1 | **Project ownership and plan** for RosiFit, UniqBrio, Jalsa and the control plane. The Free plan allows 2 active projects per owner. | Hard platform limit; backups (Free has none); compute size | Live rollout blocked | Supabase org settings |
| ☐ | SB-2 | **Application → project mapping**: which Supabase project (ref) and database hosts each application uses | Discovery and monitoring target | No production application registered | `worker/cli.ts register <config.json>` |
| ☐ | SB-3 | **Control-plane project**: where the `control` schema lives (a separate project is recommended), and its plan | Holds job state, approvals, audit | Local/synthetic only | Migrations `worker/controlplane/migrations/*` |
| ☐ | SB-4 | **Hosted validation project**: a *disposable* project (owner, plan, region) for `HOSTED_SUPABASE_VALIDATION_RUNBOOK.md`. Never RosiFit production. | Hosted behaviour is unvalidated | Hosted validation not done | Owner creates it |

## 2. Application (per application: RosiFit, UniqBrio, Jalsa)

| ☐ | ID | Decision | Until decided (fail-safe message) | Where it goes |
|---|---|---|---|---|
| ☐ | AP-1 | **Business time zone** (e.g. an IANA zone) | `CANNOT RUN — APPLICATION TIMEZONE NOT CONFIGURED`: growth shows INSUFFICIENT HISTORY; previews and jobs are refused | `applications.time_zone` |
| ☐ | AP-2 | **Retention date column** per table (which column defines a row's day) | `CANNOT RUN — RETENTION DATE COLUMN NOT CONFIGURED` | `retention_policies.date_column` |
| ☐ | AP-3 | **Retention policy** per table: `ARCHIVE` / `DO_NOT_ARCHIVE` (default `REVIEW_REQUIRED`) | Table is never archived | `retention_policies.policy` |
| ☐ | AP-4 | **Protected period** (months kept in the live DB) per table | `CANNOT RUN — PROTECTED PERIOD NOT CONFIGURED` | `retention_policies.protected_period_months` |
| ☐ | AP-5 | **Grace period** (days) per table, or a system default | `CANNOT RUN — GRACE PERIOD NOT CONFIGURED` | `retention_policies.grace_period_days` / `system_settings.default_grace_period_days` |
| ☐ | AP-6 | **Archive target** (records per run) per table | `CANNOT RUN — ARCHIVE TARGET NOT CONFIGURED` | `retention_policies.target_records` |
| ☐ | AP-7 | **Below-target behaviour**: what happens when eligible whole days do not reach the target | Report only; job `cancelled` (`target_not_reached`), no boundary shown | Code change after decision (ADR Q-B2) |
| ☐ | AP-8 | **Oversized single day**: one day alone exceeds the target | Whole-day rule as written (the day is included completely) | Code change after decision (ADR Q-B3) |
| ☐ | AP-9 | **Plan database capacity (MB)** used for capacity alerts | Capacity alert cannot be evaluated without it; registration requires it for monitoring | `applications.database_capacity_mb` |

## 3. Database capacity thresholds

The **record thresholds are fixed and are not open decisions**: LOW 10,00,000 · MEDIUM 11,00,000 · HIGH 12,00,000. Do not change them.

| ☐ | ID | Decision | Current state |
|---|---|---|---|
| ☐ | CA-1 | **LOW** capacity threshold (% of plan capacity) | 70 % — **NOT FINAL** (demo value from Phase 1, flagged `capacity_thresholds_final = false`) |
| ☐ | CA-2 | **MEDIUM** capacity threshold | 80 % — **NOT FINAL** |
| ☐ | CA-3 | **HIGH** capacity threshold | 90 % — **NOT FINAL** |

## 4. Approval

| ☐ | ID | Decision | Until decided | Where it goes |
|---|---|---|---|---|
| ☐ | A-1 | **Who may approve deletion** (named people to hold the `APPROVER` role) | Nobody holds the role → no approval possible | `operator_roles` (ADMIN grants) |
| ☐ | A-2 | **Two-person approval**: how many distinct approvers are required | `DELETION NOT AUTHORIZED — APPROVAL POLICY NOT CONFIGURED` | `system_settings.approval_required_approvers` |
| ☐ | A-3 | **Approval expiry** (minutes an approval stays valid) | same | `system_settings.approval_validity_minutes` |
| ☐ | A-4 | **Authorization expiry** (minutes the final ADMIN authorization stays valid) | same | `system_settings.authorization_validity_minutes` |
| ☐ | A-5 | **Deletion time window** (start, end, time zone) | same (`DELETION TIME WINDOW NOT CONFIGURED`) | `system_settings.deletion_window_*` |
| ☐ | A-6 | **May the job creator approve their own job?** | same | `system_settings.approval_excludes_job_creator` |
| ☐ | A-7 | **Emergency kill-switch authority**. Built-in design, to confirm: anyone with OPERATOR, APPROVER or ADMIN may **engage**; only ADMIN may **release**. Also: who is on call. | Kill switch is ON by default | `operator_roles`; runbook contacts |
| ☐ | A-8 | **Who holds ADMIN** (authorizes deletion, releases the kill switch, manages roles and credentials) | Nobody | `operator_roles` |
| ☐ | A-9 | Confirm the built-in **separation-of-duties** rule: the authorizing ADMIN may never be an approver of the same job | Enforced | — |

## 5. Archive

| ☐ | ID | Decision | Until decided | Where it goes |
|---|---|---|---|---|
| ☐ | AR-1 | **Storage provider** (S3-compatible, GCS, Supabase Storage, …). Depends on L-1. | `ARCHIVE EXECUTION UNAVAILABLE` (only a local test destination exists, synthetic apps only) | `ARCHIVE_STORAGE_PROVIDER` + a provider adapter under `worker/archive/providers/` |
| ☐ | AR-2 | **Storage region** | same | provider configuration |
| ☐ | AR-3 | **Archive retention** per data category (how long archives are kept) | Archives kept; nothing purged | purge policy (future) |
| ☐ | AR-4 | **Archive purge policy** (who authorizes, how, audit) | `ARCHIVE PURGE DISABLED` | `ARCHIVE_PURGE_ENABLED` stays false |
| ☐ | AR-5 | **Second safety copy** before deletion (a pre-deletion dump or a second archive copy). Free plan has no backups. | Not implemented; recommended | runbook + code |
| ☐ | AR-6 | **Client-side encryption** of archives (ADR §16.5) | Provider default encryption only (once a provider exists) | provider adapter |
| ☐ | AR-7 | Archive **format** confirmation (CSV.GZ implemented; Parquet deferred per Phase 3A) | CSV.GZ | `archive_format` |

## 6. Security

| ☐ | ID | Decision | Until decided | Where it goes |
|---|---|---|---|---|
| ☐ | S-1 | **Authentication provider** (e.g. Supabase Auth on the control-plane project, or an SSO/OIDC provider). Includes the token type (HS256 shared secret vs asymmetric/JWKS). | `AUTHENTICATION NOT CONFIGURED`: writes refused; anonymous reads refused once any production app is registered | `CONTROL_PLANE_AUTH_*` env; a JWKS verifier if asymmetric |
| ☐ | S-2 | **Role holders** for VIEWER / OPERATOR / APPROVER / ADMIN (see `CONTROL_PLANE_SECURITY.md`) | No roles granted | `operator_roles` |
| ☐ | S-3 | **Secret store** (the worker platform's secrets, a cloud secret manager, or Supabase Vault) | `env:` references only; `vault:` refused (`SECRET_STORE_NOT_CONFIGURED`) | `SecretBackend` implementation |
| ☐ | S-4 | **Credential rotation policy** (cadence; staff-change and incident triggers) | Manual; documented procedure | runbook |
| ☐ | S-5 | **MFA** required for APPROVER/ADMIN? | Not enforced by the control plane (identity-provider feature) | identity provider |
| ☐ | S-6 | **Maximum session age** | Not limited beyond token expiry | `CONTROL_PLANE_AUTH_MAX_AGE_SECONDS` |
| ☐ | S-7 | **Worker hosting** (where the worker runs; network path to Supabase; India hosting preference) | Worker runs only locally | deployment |

## 7. Notifications and scheduling (later; recorded for completeness)

| ☐ | ID | Decision | Until decided |
|---|---|---|---|
| ☐ | N-1 | WhatsApp / email **provider**, sender, recipients, quiet hours, which events notify | `NOTIFICATIONS DISABLED` (outbox records `suppressed` only; enforced by a database CHECK) |
| ☐ | SC-1 | **Scheduler**: host, cadence, whether first runs may be scheduled | `SCHEDULING DISABLED` (schedules cannot be enabled; enforced by a database CHECK) |

## 8. Legal and data-governance questions

**These are questions for counsel, not conclusions.** No legal position is taken here.

| ☐ | ID | Question |
|---|---|---|
| ☐ | L-1 | Must archives and logs containing Indian users' personal data be stored **in India**? This decides AR-1 and AR-2. |
| ☐ | L-2 | Could any application, or UniqBotz, be a **Significant Data Fiduciary**, or fall in a class with prescribed retention caps? |
| ☐ | L-3 | What is the required **retention period per data category** (attendance, payments, orders, audit logs), including tax and accounting retention? |
| ☐ | L-4 | Must **erasure requests** be applied inside archives, and within what time? This affects archive rewrite capability and WORM/object lock. |
| ☐ | L-5 | How long must **audit and processing logs** be kept, and where (reported: DPDP Rules ≥ 1 year; CERT-In 180 days in India)? |
| ☐ | L-6 | Who is the **accountable owner** (grievance officer / DPO-equivalent) for archives? |
| ☐ | L-7 | Is **client-side encryption** required for archives containing personal data? |
| ☐ | L-8 | Do user-facing privacy notices need to mention **archiving to secondary storage**? |
| ☐ | L-9 | Is a **data processing agreement** needed with the chosen storage provider and worker host? |

---

**Sign-off.** When every item in sections 1–6 and 8 is decided, attach this checklist, with the decision references, to the Phase 3D (production pilot) request. The production pilot also requires the hosted validation (`HOSTED_SUPABASE_VALIDATION_RUNBOOK.md`) to have passed.
