# UniqBotz Infrastructure

Central, internal control plane for **data retention and archival** across UniqBotz applications
(RosiFit, UniqBrio, Jalsa Restaurant and future products). Each application is an independent
Supabase project with its own schema; this dashboard monitors them all from one place.

> **Phase 1 — UI prototype.** Everything runs on typed mock data. No Supabase project, database,
> object storage, worker, queue, scheduler, WhatsApp or email integration is connected, and no
> destructive operation is possible. Deletion confirmation is simulated and always deletes 0 records.

## Stack

Next.js 16 (App Router) · React 19 · TypeScript (strict) · Tailwind CSS v4 · lucide-react icons ·
Vitest. No component library; the design system lives in `src/components/ui` and the tokens in
`src/app/globals.css`.

```bash
npm install
npm run dev        # http://localhost:3000
npm run lint
npm run typecheck
npm test
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
