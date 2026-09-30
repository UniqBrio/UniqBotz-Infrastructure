# UniqBotz Infrastructure

Central, internal control plane for **data retention and archival** across UniqBotz applications
(RosiFit, UniqBrio, Jalsa Restaurant and future products). Each application is an independent
Supabase project with its own schema; this dashboard monitors them all from one place.

> **Status — Phase 3C (production-readiness preparation).** Read-only monitoring and archive-and-verify are implemented and tested
> on synthetic local data. **Production deletion, automated scheduling and notifications are DISABLED.** The system is
> **not production-ready**: it is waiting on business decisions and hosted-Supabase validation.
> See [Phase 3C](#phase-3c--production-readiness).

## Stack

Next.js 16 (App Router) · React 19 · TypeScript (strict) · Tailwind CSS v4 · lucide-react icons ·
Vitest. No component library; the design system lives in `src/components/ui` and the tokens in
`src/app/globals.css`.

```bash
npm install
npm run dev        # http://localhost:3000
npm run lint
npm run typecheck
npm test                  # unit tests (no database)
npm run test:integration  # worker/control-plane tests on the local Supabase Postgres image (synthetic)
npm run build
```

## Routes

| Route | Page |
| --- | --- |
| `/` | Overview — KPIs, needs-attention list, application health, thresholds, 6-month growth |
| `/applications` | Application registry |
| `/applications/[appId]` | Application detail — database health, table overview, growth, jobs, alerts |
| `/database-health` | Technical database/table health (sizes are demo estimates) |
| `/retention` | Retention configuration + policy editor (Review Required / Don't Archive / Archive) |
| `/archive-candidates` | Day-wise whole-day selection previews (single and multi-table) |
| `/archive-jobs` | Job list and lifecycle |
| `/archive-jobs/[jobId]` | Job pipeline, verification gate, deletion review (simulated) |
| `/archive-history` | Searchable finished runs |
| `/alerts` | LOW / MEDIUM / HIGH / RESOLVED alerts with WhatsApp delivery status |
| `/audit-log` | Filterable audit trail |
| `/settings` | Thresholds, archive target, notifications, safety, prototype controls |

## Architecture

```
src/
  app/                    thin route files (metadata + a view component)
  components/
    layout/               AppShell, Sidebar, TopBar, ApplicationSwitcher, PrototypeBanner
    ui/                   Card, Badge, Button, Table, Form controls, Dialog, ConfirmationDialog, states
    status/               SeverityBadge, HealthStatusBadge, JobStatusBadge, PolicyBadge, VerificationStatus …
    monitoring/           MetricCard, ApplicationCard, DatabaseUsageCard, GrowthChart, ThresholdLadder, TableHealthTable
    retention/            RetentionPolicyTable, RetentionPolicyEditor, RetentionFlowStrip
    archive/              ArchiveCandidateCard, ArchiveDayTimeline, FinalDayEquation, ArchiveJobTable, ArchiveJobPipeline, DeletionReview
    alerts/, audit/       AlertTable, AuditLogTable
    views/                one view per page, composed from the components above
  lib/
    domain/               types, severity, whole-day selection, health derivation, formatting (pure, tested)
    data/
      source.ts           InfrastructureDataSource — the only contract the UI depends on
      mock/               seed data + MockDataSource (in-memory, session-only)
      DataProvider.tsx    picks the data source for the app
      hooks.ts            useApplications, useTables, useArchiveJobs, … (+ loading/error states)
      scope.ts            global application scope ("All Applications" or one app)
```

**Connecting a backend later:** implement `InfrastructureDataSource` (for example as a client for
Next.js route handlers that hold each application's Supabase credentials server-side) and return it
from `createDataSource()` in `src/lib/data/DataProvider.tsx`. Components and pages do not change.

## Safety rules encoded in the UI

- New/unknown tables default to **Review Required** and can never be archived until an operator sets **Archive** and enables it.
- Thresholds (10L → LOW, 11L → MEDIUM, 12L → HIGH) raise alerts only; they never archive data.
- Archive selection processes whole days oldest-first and **never splits the final day** (e.g. 124,999 + 250 = 125,249).
- **Archive verification is a hard gate.** Failed verification shows *Records deleted: 0* and no deletion action exists.
- Deletion is never an ordinary button: it requires a verified archive, an explicit review, and typing the job ID.

Database-capacity thresholds (70/80/90%) are configurable demo defaults, not confirmed business rules.

## Phase 2 Architecture Investigation

Phase 2 is an architecture investigation only. It adds no backend, connections, credentials, workers,
storage or deletion code. The outcome is
[`PHASE_2_ARCHITECTURE_DECISION_RECORD.md`](./PHASE_2_ARCHITECTURE_DECISION_RECORD.md), the authoritative
architecture decision record. In summary:

- **Recommended shape:** a hybrid design. A central control plane (this app plus a central Postgres for
  policies, jobs, approvals and audit) hands work to **one stateless external worker**. The worker exports,
  verifies and deletes. Nothing is installed in application databases except two least-privilege login roles.
- **Deletion safety:** the candidate set is frozen in one read-only snapshot, which produces an exact
  primary-key manifest with a per-row hash. Deletion only touches **those primary keys, and only rows unchanged
  since export**. It is never a date-range delete.
- **Verification gate:** object existence, checksums, gzip integrity, row counts and a primary-key set match
  are all fully verified on every job. Failure → 0 rows deleted.
- **Supabase Free Plan realities:** 500 MB then read-only (which also blocks DELETE); no downloadable backups;
  2 active free projects per owner; IPv6-only direct connections (use the Supavisor pooler); DELETE does not
  shrink the database immediately.
- **Open items:** plan/ownership of projects, archive data location (India residency decides the storage
  provider), behaviour when the target is not reached, capacity threshold values, approval rules, archive
  retention and erasure. See §21 of the ADR, which also lists the technical prototypes required before Phase 3.

## Phase 3A Technical Validation

The critical Phase 2 assumptions were prototyped on a local copy of the official Supabase Postgres image with
**synthetic data only** (`prototype/`, reproducible with `prototype/scripts/run-all.sh`). All 161 checks passed.
Several findings refine the architecture; see
[`PHASE_3A_TECHNICAL_VALIDATION_REPORT.md`](./PHASE_3A_TECHNICAL_VALIDATION_REPORT.md). Hosted-Supabase behaviour is not yet validated.

## Phase 3B: Control Plane + Read-Only Live Monitoring

```
READ-ONLY MONITORING: IMPLEMENTED · ARCHIVE-AND-VERIFY: IMPLEMENTED/TESTED
PRODUCTION DELETION: DISABLED · AUTOMATED SCHEDULING: DISABLED · PRODUCTION NOTIFICATIONS: DISABLED
```

- **Control plane** (`worker/controlplane/migrations/`): Postgres schema `control` with 19 tables.
  - Kill switch defaults to ON.
  - No default grace period.
  - Notifications and scheduling are CHECK-constrained off.
  - The audit log is append-only.
  - Connection passwords must be `env:NAME` references.
- **Worker** (`worker/`, operator CLI `npx tsx worker/cli.ts …`, manual only). It does:
  - read-only discovery and health collection;
  - six-month growth, reported as INSUFFICIENT HISTORY when it cannot be proven;
  - read-only candidate previews;
  - `ARCHIVE_AND_VERIFY_ONLY` jobs: freeze → export → full restore-and-fingerprint verification → stop at `ready_for_deletion`.
- **Deletion:** the engine exists but is disabled.
  - `ALLOW_DELETION=false` by default, the database kill switch is ON, and only `synthetic` environments are allow-listed (`production` is rejected).
  - It was exercised only on throwaway local synthetic databases in tests.
- **Dashboard live mode:** `NEXT_PUBLIC_INFRA_DATA_SOURCE=live` plus the server-side `CONTROL_PLANE_DATABASE_URL`.
  - The browser talks to GET-only `/api/infra/*`, which reads the control plane in a read-only session. Writes return 403.
  - The web tier never connects to application databases or sees their credentials.
- **Tests:** 67 unit (`npm test`) and 45 integration (`npm run test:integration`, needs `prototype/scripts/start-db.sh`). Phase 3A's 161 checks still pass.
- **Hosted Supabase:** not validated. No disposable project was available, and none was created.

Details, limitations, unresolved decisions and the exact steps before any production deletion:
[`PHASE_3B_IMPLEMENTATION_RECORD.md`](./PHASE_3B_IMPLEMENTATION_RECORD.md).

## Phase 3C — Production Readiness

**Current safety state**

```
READ-ONLY MONITORING: IMPLEMENTED       ARCHIVE-AND-VERIFY: IMPLEMENTED/TESTED (synthetic)
PRODUCTION DELETION: DISABLED           AUTOMATED SCHEDULING: DISABLED        PRODUCTION NOTIFICATIONS: DISABLED
```

A green build is **not** production readiness. Production use is blocked until the decisions and validations below exist.

**What Phase 3C added**

- **Fail-safe configuration.** Missing values refuse with fixed messages, never a guess, e.g.:
  - `CANNOT RUN — GRACE PERIOD NOT CONFIGURED`
  - `CANNOT RUN — APPLICATION TIMEZONE NOT CONFIGURED`
  - `CANNOT RUN — RETENTION DATE COLUMN NOT CONFIGURED`
  - `DELETION NOT AUTHORIZED`
  - `ARCHIVE EXECUTION UNAVAILABLE`
- **Authentication boundary.** Server-side token verification; roles VIEWER / OPERATOR / APPROVER / ADMIN come from the control plane; writes are CSRF-safe.
  - Reads are refused anonymously once a production application is registered.
  - Nobody can execute deletion from the dashboard.
  - See [`CONTROL_PLANE_SECURITY.md`](./CONTROL_PLANE_SECURITY.md).
- **Approval workflow, execution disabled.** Archive verified → deletion review → evidence-bound approvals → ADMIN authorization → worker execution.
  - The job page shows the evidence, the approval history and **PRODUCTION DELETION DISABLED**.
  - The worker re-validates everything and still refuses while `ALLOW_DELETION=false`.
- **Infrastructure abstractions.** Secret references by kind; a provider-neutral `ArchiveStorage` (no provider chosen; the local directory is for synthetic apps only; purge disabled); disabled scheduling and notification interfaces; a redacting structured logger.
- **Read-only discovery.** `npx tsx worker/cli.ts discover <app> report.md` is the first production step. Every table becomes REVIEW_REQUIRED, and a monitor role with write privileges is flagged.

**Required decisions:** [`PRODUCTION_DECISION_CHECKLIST.md`](./PRODUCTION_DECISION_CHECKLIST.md)

- Supabase ownership/plans;
- per-application time zone, date columns, policies, protected period, grace and target;
- capacity thresholds (record thresholds stay 10L/11L/12L);
- approvers and the approval policy;
- archive provider, region and retention;
- authentication provider and secret store;
- legal questions.

**Hosted validation requirement:** [`HOSTED_SUPABASE_VALIDATION_RUNBOOK.md`](./HOSTED_SUPABASE_VALIDATION_RUNBOOK.md)

- 16 checks on a **disposable** project, with synthetic data, run by `worker/hosted-validation/validate.ts`.
- The script refuses known production refs and non-empty databases.

**Production pilot plan:** [`PRODUCTION_PILOT_PLAN.md`](./PRODUCTION_PILOT_PLAN.md) — one application, one low-risk table, read/archive/verify only, zero delete.

Also see:

- [`PHASE_3C_PRODUCTION_READINESS_GAP_REPORT.md`](./PHASE_3C_PRODUCTION_READINESS_GAP_REPORT.md)
- [`ROSIFIT_READ_ONLY_DISCOVERY_REPORT.md`](./ROSIFIT_READ_ONLY_DISCOVERY_REPORT.md) — procedure prepared; discovery not yet performed
- [`PRODUCTION_ARCHIVE_RUNBOOK.md`](./PRODUCTION_ARCHIVE_RUNBOOK.md)
- [`PRODUCTION_DELETION_CHECKLIST.md`](./PRODUCTION_DELETION_CHECKLIST.md)
