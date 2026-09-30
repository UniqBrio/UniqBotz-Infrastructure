# Phase 3B — Implementation Record

**Scope:** a control plane, **read-only** live monitoring, and a worker that can **archive and verify** but not delete.
The deletion engine exists and is tested on synthetic local data only. It is **disabled** in every shipped configuration.

```
READ-ONLY MONITORING:      IMPLEMENTED
ARCHIVE-AND-VERIFY:        IMPLEMENTED / TESTED (synthetic, local)
PRODUCTION DELETION:       DISABLED
AUTOMATED SCHEDULING:      DISABLED
PRODUCTION NOTIFICATIONS:  DISABLED
```

Related documents:

- `PHASE_2_ARCHITECTURE_DECISION_RECORD.md` (the ADR). This phase follows its decisions (§21, §22).
- `PHASE_3A_TECHNICAL_VALIDATION_REPORT.md` (the prototype evidence behind every safety rule used here).

---

## Contents

1. [What was built](#1-what-was-built)
2. [Hosted Supabase spike — not performed](#2-hosted-supabase-spike--not-performed)
3. [Architecture implemented](#3-architecture-implemented)
4. [Modules](#4-modules)
5. [Control-plane schema](#5-control-plane-schema)
6. [Connection and secret model](#6-connection-and-secret-model)
7. [Live monitoring](#7-live-monitoring)
8. [Candidate preview](#8-candidate-preview)
9. [Archive-and-verify-only flow](#9-archive-and-verify-only-flow)
10. [Deletion engine (implemented, disabled)](#10-deletion-engine-implemented-disabled)
11. [Safety controls](#11-safety-controls)
12. [Tests](#12-tests)
13. [How to run](#13-how-to-run)
14. [Known limitations](#14-known-limitations)
15. [Unresolved decisions](#15-unresolved-decisions)
16. [Exact steps required before production deletion](#16-exact-steps-required-before-production-deletion)

---

## 1. What was built

| Area | Delivered |
|---|---|
| Control plane | Postgres schema `control`: 19 tables, a migration runner, and constraints that encode the safety defaults |
| Worker | `worker/`: TypeScript package extracted from the Phase 3A prototype and hardened. Modules: discovery, health, preview, freeze/export, verification gate, deletion gate and engine, job runner, leases, retries, audit |
| Operator CLI | `worker/cli.ts`. Manual one-shot commands: `migrate`, `register`, `collect`, `job:create`, `job:run`, `status`. There is no scheduler and no approve command |
| Live UI path | `/api/infra/*` (GET only) → server-only service → control plane (read-only session). `ApiDataSource` implements the Phase 1 `InfrastructureDataSource` contract |
| UI | Phase 1 screens now also render live data. Additions: a green "LIVE · READ-ONLY" banner, a runtime safety panel in Settings, INSUFFICIENT HISTORY growth panels, estimate vs exact counts, read-only candidate previews with exclusions and blocking reasons, and "Deletion disabled in this deployment" in Deletion Review. Writes are disabled in live mode |
| Tests | 67 unit tests (`npm test`) and 45 integration tests on the local Supabase Postgres image (`npm run test:integration`). All 161 Phase 3A checks re-run and pass |

What was **not** done, as instructed:

- no production connection of any kind;
- no production archive bucket;
- no deletion outside throwaway synthetic local databases;
- no scheduler;
- no WhatsApp or email;
- no final archive provider, capacity thresholds, grace values, approval policy or legal retention rules;
- no production credentials.

## 2. Hosted Supabase spike — not performed

The brief allowed a disposable hosted Supabase project if one was available or could be created safely. It said not to create one automatically. The situation was:

- The connected Supabase account has one organization ("RosiFit", Free plan).
- That organization contains exactly one project: production **Rosifit** (`lhpzhkzbnquwjljmbylo`, Postgres 17.6.1.166). It must not be used.
- No disposable project exists, and none was created.
- The session's network allows HTTPS only. Postgres ports (5432 and 6543, pooler and direct) are unreachable, so the worker could not have connected to a hosted project from here even if one existed.

**Consequence:** all Phase 3B behaviour is validated only against the official Supabase Postgres image (`supabase/postgres:17.6.1.066`) running locally. The hosted checks still outstanding are listed in §16 (step 2).

## 3. Architecture implemented

This is ADR Option 2, a central external worker. The control plane is a separate database.

```
 Browser ──GET──▶ Next.js /api/infra/* ──(read-only session)──▶ CONTROL PLANE (schema control)
   ▲  no credentials        server-only service                          ▲
   │                                                                     │ read/write (jobs, audit, stats)
   └── Phase 1 UI (ApiDataSource | MockDataSource)                       │
                                                               WORKER (manual CLI, no scheduler)
                                                                 │ monitor role  → SET default_transaction_read_only = on
                                                                 │ archive role  → SELECT (+ DELETE only if ever enabled)
                                                                 ▼
                                                       APPLICATION DATABASES (one per app)
                                                                 │ CSV.GZ + keys + schema.json + manifest
                                                                 ▼
                                                       ARCHIVE STORE (local directory in Phase 3B)
```

- The **web server never connects to application databases** and never resolves their secrets. It reads the control plane only, in a `default_transaction_read_only=on` session. POST, PUT, PATCH and DELETE return 403.
- The **worker** is the only component that resolves `env:` secret references and opens application connections.
- Every application connection pins its session (UTC, ISO dates, `extra_float_digits=1`, hex bytea) so that row fingerprints are reproducible (Phase 3A P1).

## 4. Modules

| Path | Responsibility |
|---|---|
| `worker/config.ts` | `ALLOW_DELETION` (true only for the exact string `"true"`), `DELETION_ALLOWED_ENVIRONMENTS` (default `synthetic`; `production` rejected at start-up), batch size (default 2,000, range 1–5,000), lease, verification max age |
| `worker/connection/` | `SecretRef` types and config validation; `EnvSecretResolver`; `openConnection` (pinned session, error handler, read-only monitor session); `beginOwned` nested-transaction guard; error classification |
| `worker/discovery/` | Catalog discovery: tables, columns, PKs, indexes, RLS, sizes, dead tuples, date candidates, insertion column. FK graph from `pg_constraint`: Kahn order, Tarjan cycles, selection validation, graph hash |
| `worker/schema/` | `describeTable` and `schemaHash` (columns, PK, constraints, triggers, RLS); row fingerprint SQL |
| `worker/retention/` | Policy model (`REVIEW_REQUIRED` default; validation; no built-in grace). Group planning with RLS preflight and FK closure; eligibility cutoff; local "today" |
| `worker/candidates/` | Whole-day selection (reuses the Phase 1 `src/lib/domain/selection.ts`); read-only preview |
| `worker/archive/` | CSV.GZ format, `ArchiveStore` interface plus `LocalDirectoryStore`, manifest v2, `freezeAndExport` (selection + export + key capture in one RR READ ONLY snapshot) |
| `worker/verification/gate.ts` | Six-stage gate, including a full restore of every row into a scratch database and fingerprint reconciliation |
| `worker/deletion/` | Pure deletion gate (reports every reason). Batch engine: exact PK + fingerprint + NOT EXISTS referencing rows; never a date predicate |
| `worker/jobs/` | State machine, job creation from stored policies, approval (refused for verify-only jobs), cancel, crash-point injection (tests only), chunked candidate persistence with digests, `JobRunner` |
| `worker/recovery/` | Leases with heartbeat and takeover; retry and backoff decision |
| `worker/health/` | Six-month growth (INSUFFICIENT HISTORY rules, spike detection); collector (discovery persistence, REVIEW_REQUIRED defaults, exact vs estimated counts, snapshots, alerts, previews) |
| `worker/audit/` | Append-only audit writer |
| `worker/controlplane/` | Migration `0001_control_plane.sql`, runner, repository (settings, applications, policies) |
| `src/server/live/` | `service.ts` (server-only, read-only pool) and `mapping.ts` (pure row → UI mapping; connection details are never mapped) |
| `src/app/api/infra/[...path]/route.ts` | Read-only API |
| `src/lib/data/api/apiDataSource.ts` | Browser data source; write methods call the API and surface its 403 |

## 5. Control-plane schema

Migration: `worker/controlplane/migrations/0001_control_plane.sql`. Applied migrations are tracked in `public.control_schema_migrations`. Every table carries a `COMMENT`.

| Table | Purpose | Key safety constraints |
|---|---|---|
| `applications` | Registered apps; environment `synthetic`, `staging` or `production`; time zone; capacity; connection status | environment CHECK |
| `application_connections` | Host, port, database, user **and a secret reference** per purpose (`monitor`, `archive`) | `password_secret_ref ~ '^(env\|vault):NAME$'`. An inline password is rejected by the database |
| `discovered_tables`, `table_columns`, `foreign_keys` | Latest discovery | — |
| `table_stats_snapshots`, `database_stats_snapshots` | One row per table (or database) per local day | unique per day |
| `retention_policies` | Operator decisions | default `REVIEW_REQUIRED`. `only_archive_can_be_enabled`. `enabled_archive_is_complete`: a root needs a date column, protected period and target; a group member follows its root |
| `candidate_previews` | Latest read-only preview per group | status CHECK |
| `archive_jobs` | Job state, mode, attempt, retry, spec, selection, schema/graph hash, approval, failure | mode defaults to `ARCHIVE_AND_VERIFY_ONLY`. **Unique partial index: one active job per (application, group)** |
| `archive_job_tables` | Membership, role, delete order, reconciliation | — |
| `archive_job_candidates` | **Exact frozen identity**: PK[], fingerprint[], parent_key[] in chunks, each with a SHA-256 digest | cardinality CHECK |
| `archive_manifests` | Store URI, manifest key and hash, expected files (bytes, sha256, raw sha256) | one per (job, attempt) |
| `archive_verifications` | Gate result per attempt with every check | — |
| `archive_deletion_batches` | Per-batch checkpoints (`started` → `done`) with per-table outcomes | — |
| `alerts` | Record and capacity alerts; escalation; resolve | one active alert per subject. `notification` defaults to `disabled` |
| `audit_logs` | Every event | **append-only**: triggers refuse UPDATE, DELETE and TRUNCATE |
| `worker_leases` | Job leases (owner, heartbeat, expiry) | — |
| `system_settings` | Singleton | thresholds 10/11/12 lakh; capacity 70/80/90 % with `capacity_thresholds_final = false`; `default_grace_period_days NULL`; batch 2,000 (1–5,000); **`deletion_kill_switch` default ON**; `notifications_enabled` and `scheduling_enabled` are CHECK-constrained to `false` |

## 6. Connection and secret model

- **Application config** (`ApplicationConfig`) holds no secrets. A password is always an `env:NAME` reference. `vault:NAME` is reserved but not implemented.
  - `validateApplicationConfig` rejects literals and missing connections.
  - Monitoring requires a plan capacity, so capacity alerts are meaningful.
- **Resolution** happens only inside the worker process (`EnvSecretResolver`). A missing variable fails loudly and is never defaulted.
- **Two roles per application (recommended):**
  - `monitor`: SELECT on catalog and statistics, plus SELECT on tables for exact counts and growth. The session is forced read-only.
  - `archive`: SELECT for export. DELETE is needed only if deletion is ever enabled. MAINTAIN is optional (VACUUM).
  - The tests use exactly these least-privilege roles.
- **RLS:** a role without BYPASSRLS is blind to hidden rows.
  - The collector keeps planner estimates for such tables and reports growth as INSUFFICIENT HISTORY.
  - The job planner **blocks** such tables (`rls_hides_rows`).
- **Dashboard:** `CONTROL_PLANE_DATABASE_URL` is server-side only. Nothing server-side is `NEXT_PUBLIC_*`, and the production client bundle was checked for control-plane identifiers (none found).

## 7. Live monitoring

`npx tsx worker/cli.ts collect <app>` runs manually. There is no scheduler.

1. **Discovery** runs through the read-only monitor session. Supabase system schemas are excluded. `created_at` is never assumed.
2. **Persistence.** Every newly seen table gets a `REVIEW_REQUIRED`, disabled policy with no grace period, audited as `table_discovered` and `policy_defaulted`. Vanished tables are marked `is_present = false`.
3. **Counts.** Exact counts are taken when the estimate is ≤ 200k rows or within ±5 % of a threshold. Otherwise the planner estimate is used, and the UI labels it as an estimate.
4. **Growth.** This is "average records added per day over the last six months":
   - Window: the last six **complete** calendar months in the application time zone. The current month is excluded.
   - Rows counted: rows whose **insertion timestamp** (a timestamp column defaulting to `now()`) falls in the window.
   - Average: those rows ÷ days in the window. Spike days (> 5× the median) are flagged, and the average is also reported without them.
   - Result is **INSUFFICIENT HISTORY** when any of these hold: no insertion column; the oldest surviving row is newer than the window start; the table is empty; RLS hides rows. A rate is never invented.
   - Rows deleted after insertion are not counted (`countsSurvivingRowsOnly`).
5. **Snapshots and alerts.**
   - One table and database snapshot per local day.
   - Record alerts use LOW/MEDIUM/HIGH at the configured thresholds. They escalate or resolve on each collection.
   - Capacity alerts use the configured, NOT FINAL percentages of the declared plan capacity.
   - **No notification is sent.** The UI states "Notifications are DISABLED in Phase 3B — nothing was sent."
6. **Failure.** An unreachable application becomes `disconnected` (or `degraded`), the failure is audited (`collection_failed`), and the process does not crash.

## 8. Candidate preview

- Computed during collection for each **enabled ARCHIVE root**, inside a `REPEATABLE READ READ ONLY` transaction on the monitor session. It writes nothing to the application and creates no job.
- Cutoff = local today − protected months − **configured** grace days. If no grace period is configured at table or system level, the preview is `blocked` ("grace period is not configured (no built-in default)").
- Whole-day rule: oldest eligible day upward, adding full days until the target is reached. The final day is included completely.
- **No boundary is reported unless the target is actually reached.** In that case `status = target_not_reached`, `boundaryDate = null` and `candidateCount = 0`, plus an exclusion line explaining why.
- Exclusions are itemised: NULL dates, protected period, after the boundary, and target not reached.
- FK problems (for example a CASCADE child not selected, or a cycle), RLS and incomplete policies produce `blocked` with reasons.

## 9. Archive-and-verify-only flow

Default mode is `ARCHIVE_AND_VERIFY_ONLY`. `job:create` builds the spec **only from stored, enabled ARCHIVE policies**. Unknown or REVIEW_REQUIRED tables are refused.

```
queued → preparing → freezing/exporting → verifying → ready_for_deletion   (stops here; 0 rows deleted)
            │               │                   │
            │ preflight     │ target not        │ any gate stage fails
            ▼ blocked       ▼ reached           ▼
          failed         cancelled            failed  (failure.deleted = 0)
```

**preparing.** The worker plans the group:

- schemas;
- FK graph and closure from the root;
- RLS preflight;
- single-column PK check;
- temporal date column.

Blocking issues move the job to `failed`. On success it records the schema hash and graph hash.

**freezing/exporting.** A new attempt number is assigned and earlier attempts' objects and candidates are removed. Then, inside one `REPEATABLE READ READ ONLY` snapshot:

- the whole-day selection is computed;
- every row is exported (`COPY … TO STDOUT` → gzip → store);
- the key stream (pk, fingerprint, parent key) is written to the store and to `archive_job_candidates` in digest-protected chunks;
- `schema.json` and `manifest.json` are written.

The job fails if the schema changed since planning.

**verifying.** The gate checks six stages in order. The first failure stops it.

1. `archive_created`: every object exists at the recorded size; the manifest names this job, attempt and application; boundary matches.
2. `archive_integrity`: manifest and object SHA-256 match the control plane; every object fully gunzips and parses; uncompressed hashes match.
3. `archive_row_count`: data rows, key rows and manifest rows equal the control plane; Σ day totals = Σ rows.
4. `archive_key_set`: data PK set = key set with no duplicates; keys digest = freeze digest; archive keys = **control-plane frozen candidates (PK + fingerprint)**.
5. `restore_fingerprint`: **every row** is restored into a scratch database and every fingerprint re-derived and compared. Sampling is never used.
6. `schema_hash`: manifest = control plane = live source now.

**ready_for_deletion.** The runner stops. `approveDeletion` is **refused** for verify-only jobs, and the refusal is audited. Even if the status is tampered to `deletion_approved`, the worker evaluates the deletion gate and refuses: `ALLOW_DELETION=false`, the job mode and the kill switch are all reported, and 0 rows are deleted.

## 10. Deletion engine (implemented, disabled)

This is present so that Phase 3C can validate it. It is tested **only** on throwaway synthetic local databases, using a test-only config.

- **Gate.** The pure function `evaluateDeletionGate` returns every reason that applies.
  - Runtime switches: `ALLOW_DELETION` false; application environment not allow-listed; kill switch ON.
  - Job state: mode not `ARCHIVE_VERIFY_DELETE`; status not `deletion_approved`/`deleting`.
  - Verification: missing, failed, from another attempt, or older than the max age.
  - Drift: schema hash or FK graph hash changed.
  - Candidate set: failed its digest check.
- **Batch.** Each batch is one short transaction with `SET LOCAL lock_timeout` and `statement_timeout`.
  - Delete predicate: `DELETE … USING unnest(pk[]) … AND fingerprint = frozen AND NOT EXISTS (referencing rows)`, children before parents in graph order.
  - Outcomes per table: deleted, drifted (edited → skipped), held (newly referenced → skipped), missing.
  - **Never** `WHERE date < cutoff`.
- **Around each batch.**
  - Before: kill switch and schema/graph re-checks.
  - Checkpoints `started` → `done`, and a `deletion_batch_completed` audit.
- **After deletion.**
  - Reconciliation per table: frozen = requested = deleted + skipped + missing, and still present = skipped.
  - `VACUUM (ANALYZE)` per table. A missing privilege is recorded as "skipped". `VACUUM FULL` is never run.
- **End state.** `completed`, `completed_with_exceptions` (something skipped) or `requires_review`.

## 11. Safety controls

| # | Validated principle (Phase 3A) | Where enforced in Phase 3B | Test |
|---|---|---|---|
| 1 | Candidate selection inside the freeze snapshot | `freezeAndExport` computes the selection inside RR READ ONLY; the preview boundary is kept only for comparison | archive-verify: freeze |
| 2 | Exact PK + row fingerprint identity | `archive_job_candidates`; batch predicate | archive-verify: freeze; deletion: exact |
| 3 | Schema hash captured and verified | job `schema_hash`; gate stage 6; deletion gate; per-batch check | schema-hash failure; schema mismatch before deletion |
| 4 | Full restore/read verification | gate stage 5 (all rows) | ready_for_deletion; corruption; fingerprint mismatch |
| 5 | Failed verification ⇒ 0 deletions | gate → `failed` with `deleted: 0`; deletion gate requires verified | corruption, fingerprint, schema |
| 6 | Delete only exact verified keys | batch uses frozen keys from the verified attempt | deletion: exact |
| 7 | Never `WHERE date < cutoff` | batch SQL has no date predicate | deletion: backdated row survives |
| 8 | FK order from the actual graph | Kahn order from `pg_constraint`; blocked selections | FK graph (unit and integration) |
| 9 | New/backdated rows not deleted | exact keys | deletion: backdated row survives; freeze test |
| 10 | Edited candidates skipped and reported | fingerprint predicate → `drifted` | deletion: drifted row survives, `skipped` = 2 |
| 11 | Resumable, idempotent jobs | attempts, checkpoints, leases | 5 pre-deletion and 5 deletion crash points |
| 12 | One active job per group | unique partial index; `DuplicateJobError` audited | schema and archive tests |
| 13 | Kill switch prevents deletion | settings default ON; gate; per-batch re-check | kill switch before and mid-deletion |
| 14 | RLS detected in preflight | `planGroup`; collector | RLS preflight (blocked vs BYPASSRLS) |
| 15 | Connection failures are recoverable | classification → `waiting_retry` with backoff; `disconnected` status | refused connection → retry → resume |

Additional Phase 3B controls:

- `ALLOW_DELETION=false` default, plus an environment allow-list with `production` refused at start-up. Both are independent of the database kill switch.
- The web tier is read-only end to end: a read-only DB session, GET-only routes, 403 on writes, and a disabled UI.
- Secrets are references only, enforced by a database CHECK and by config validation.
- Notifications and scheduling are CHECK-constrained off.
- The audit log is append-only. Every destructive-capability event is audited:
  - approval, attempt, blocked, batch, verified, completed;
  - duplicate, takeover, retry, failure.

## 12. Tests

| Suite | Command | Result |
|---|---|---|
| Unit (Phase 1 + Phase 3B; no database) | `npm test` | **67 / 67 passed** |
| Integration (local Supabase Postgres, synthetic) | `npm run test:integration` | **45 / 45 passed** |
| Phase 3A prototypes (unchanged) | `prototype/scripts/run-all.sh` | **161 / 161 checks passed** (re-run) |
| Lint / typecheck / production build | `npm run lint` / `npm run typecheck` / `npm run build` | clean |
| Live UI smoke test | live build + synthetic control plane, Chromium screenshots | passed after fixes 5–7 below |

Coverage against the required list:

- **Control-plane schema** (`controlplane.int.test.ts`): 19 tables with comments; idempotent migration; safe defaults; notifications and scheduling cannot be enabled; inline password rejected; append-only audit; policy constraints; one active job per group.
- **Discovery** (`monitoring.int.test.ts`): tables, PKs, FKs with ON DELETE, RLS, date candidates, insertion column; system schemas excluded.
- **Real data-source adapter** (`monitoring.int.test.ts`): `ApiDataSource` → route handler → service → control plane, with real rows. Writes return 403 "READ-ONLY". Responses contain no secret references or passwords.
- **Retention policy loading** (`archive-verify.int.test.ts`, `policy.test.ts`):
  - REVIEW_REQUIRED is refused.
  - A missing grace period is refused, and the system default is used when set.
  - The spec is built from stored policies.
- **Candidate preview** (`monitoring.int.test.ts`):
  - A ready preview writes nothing to the app.
  - No boundary when the target is not reached.
  - Blocked when grace is missing.
  - Blocked for a CASCADE child that is not selected.
- **Freeze** (`archive-verify.int.test.ts`):
  - Keys equal the live PK and fingerprint.
  - Only whole days are selected.
  - A backdated row inserted after the freeze is not a candidate.
- **Archive-and-verify-only** (`archive-verify.int.test.ts`):
  - Reaches `ready_for_deletion`, all 6 stages, 0 deleted.
  - Target not reached → `cancelled`.
- **Deletion disabled** (`archive-verify.int.test.ts`, `deletion-safety.int.test.ts`):
  - Approval refused for verify-only jobs.
  - A tampered status is still refused.
  - Shipped defaults refuse an approved ARCHIVE_VERIFY_DELETE job.
- **Kill switch:** blocks even with ALLOW_DELETION=true; engaged mid-deletion, it halts at the next batch.
- **Environment:** `staging` is blocked.
- **Schema mismatch:** at verification → `failed`; before deletion → `requires_review`, 0 deleted.
- **Fingerprint mismatch:**
  - archive vs control-plane candidates → `archive_key_set` fails;
  - an edited row at deletion time is skipped and reported.
- **RLS preflight:** a non-bypass role is blocked; a BYPASSRLS role sees all members' rows.
- **FK graph:** unit tests for order, cycles, blocking kinds and hash; integration tests for real graph discovery and blocking.
- **Job recovery:**
  - Crash at 5 pre-deletion and 5 deletion points, then resume by another worker after lease expiry. Nothing outside the frozen set is deleted, and the job reconciles.
  - The lease blocks a second worker; takeover is audited.
  - ECONNREFUSED → `waiting_retry` with backoff → resume.
- **Monitoring specifics:**
  - The read-only monitor session rejects writes (25006).
  - Growth equals 10/day exactly in `Asia/Kolkata`, with the monthly breakdown.
  - INSUFFICIENT HISTORY in four cases.
  - Alerts escalate and resolve with notifications disabled.
  - A late table defaults to REVIEW_REQUIRED.
  - An unreachable app is marked `disconnected` and audited.

Bugs found by the new tests and fixed:

1. `cancelJob` passed an unused SQL parameter, which Postgres rejects ("could not determine data type of parameter $2"). Every cancel failed.
2. On Postgres 17, `VACUUM` without MAINTAIN or ownership emits a WARNING ("skipping") rather than an error, so post-deletion maintenance was wrongly recorded as OK. Notices are now captured and recorded as "skipped".
3. The collector counted rows through RLS with a non-bypass monitor role, which understates tables. Such tables now keep the planner estimate and report INSUFFICIENT HISTORY.
4. The retention-policy constraint forced FK-group **members** to have their own date column. Members now follow the root's day.

**Live UI smoke test.** I built the dashboard with `NEXT_PUBLIC_INFRA_DATA_SOURCE=live`, pointed it at a synthetic control plane (7 discovered tables, one verified job), and checked the pages in Chromium. That run found and fixed:

5. The Archive Candidates page crashed ("Invalid time value") on a blocked preview.
   - `formatDate` now renders invalid values as "—".
   - Blocked previews carry their configured context and render only the blocking reasons, with no selection.
6. **The safety-gate panel showed "DELETION: ALLOWED" for a verified ARCHIVE_AND_VERIFY_ONLY job.**
   - `isDeletionAllowed` now respects a blocked deletion state.
   - The panel now shows **DISABLED**.
   - A unit test covers this.
7. Live pages still carried DEMO/SIMULATED tags and mock-only wording. An application with no measured table showed "0 records/day".
   - Demo tags are hidden in live mode.
   - Application growth is `null` → "INSUFFICIENT HISTORY".
   - Settings and Database Health descriptions state the live, read-only source.

## 13. How to run

```bash
# 0. local disposable database (synthetic only)
prototype/scripts/start-db.sh                      # supabase/postgres:17.6.1.066 on 127.0.0.1:54329

# 1. tests
npm test                                           # unit
npm run test:integration                           # integration (creates p3b_* databases on the local server)

# 2. worker (manual, synthetic)
export CONTROL_PLANE_DATABASE_URL=postgres://postgres:…@127.0.0.1:54329/control_plane
npx tsx worker/cli.ts migrate
npx tsx worker/cli.ts register worker/examples/synthetic-app.json   # passwords are env: references
SYNTH_MONITOR_PASSWORD=… npx tsx worker/cli.ts collect synthetic-gym
npx tsx worker/cli.ts job:create synthetic-gym public.attendance J-1            # ARCHIVE_AND_VERIFY_ONLY
VERIFY_SCRATCH_DATABASE_URL=… npx tsx worker/cli.ts job:run J-1                 # stops at ready_for_deletion

# 3. dashboard in live, read-only mode
NEXT_PUBLIC_INFRA_DATA_SOURCE=live CONTROL_PLANE_DATABASE_URL=… npm run build && npm start
```

`.env.example` lists every variable, with placeholders only.

## 14. Known limitations

- **Hosted Supabase not validated.** See §2 and §16. This affects pooler behaviour, SSL, role privileges on hosted projects, `pg_stat` visibility, statement limits and network latency.
- **Archive store:** only `LocalDirectoryStore` exists. The final provider depends on Q-L1 (data location). An S3-compatible store must honour the `ArchiveStore` contract, including sha256 on put and head sizes.
- **Single-column primary keys only.** Composite or missing PKs are blocked, not supported.
- **Group members join through a single-column FK** from an already-resolved table. Multi-column FKs are blocked.
- **Growth counts surviving rows only.** Rows deleted after insertion (including by archiving) are missed until snapshot history allows net-growth calculation. This is flagged in the data.
- **Growth needs a provable insertion column.** Tables without one, and RLS-hidden tables for a non-bypass monitor role, show INSUFFICIENT HISTORY.
- **Capacity alerts** depend on the declared `databaseCapacityMb`, and the thresholds are NOT FINAL.
- **No authentication or authorization** on the dashboard. That is why every write is refused. Policies and settings change only through the operator CLI or repository functions.
- **No scheduler.** Collection and jobs are manual CLI invocations.
- `requires_review` jobs do not block a new job for the same group. An operator review workflow (resolve, retry, abandon) is not implemented.
- The candidate chunks (exact keys) stay in the control plane after a job finishes. A purge policy is undecided (Q-B10).
- `vault:` secret references are reserved but not implemented.
- An application whose database was never reached shows a database size of 0 KB rather than "unknown"; its connection status (`disconnected`) is the signal to read.
- The Phase 3A `prototype/` keeps its own copies of the libraries as frozen evidence. The production code path is `worker/`, extracted from it.

## 15. Unresolved decisions

**Business decisions** (ADR §21.2):

| ID | Decision |
|---|---|
| Q-B1 | Supabase plans and ownership for three apps plus a control plane (the Free plan allows 2 active projects per owner) |
| Q-B2 / Q-B3 | Behaviour when the target is not reached (currently: report only, job `cancelled`); a single oversized day |
| Q-B4 | Business time zone per app (tests use `Asia/Kolkata`; unconfirmed) |
| Q-B5 | Capacity thresholds (70/80/90 %, **NOT FINAL**) |
| Q-B6 | **Grace period values.** None is configured; jobs and previews refuse to plan until one is set |
| Q-B7 | **Deletion approval policy**: two-person rule, validity window, allowed windows, approver role |
| Q-B8 | Unrelated tables in one job; operator-declared relationships |
| Q-B9 | Pre-deletion safety dump or second archive copy (Free plan has no backups) |
| Q-B10 | Archive retention and purge; purge of frozen candidate keys |
| Q-B11 | Worker hosting and budget; India hosting preference |
| Q-B12 | Production authentication method and role holders |
| Q-B13 | Per-table threshold overrides |
| Q-L1…Q-L7 | Legal questions, especially data location, which decides the archive provider |

**Technical items still open:**

- final archive format (CSV.GZ is implemented; Parquet is deferred per Phase 3A);
- batch size tuning on hosted compute (2,000 is the default, not claimed optimal);
- hosted-Supabase validation (§16).

## 16. Exact steps required before production deletion

Deletion must stay disabled until **all** of the following are done, in order.

1. **Business sign-off** on Q-B1, Q-B4, Q-B6 (grace values per table), Q-B7 (approval policy), Q-B9 (safety copy), Q-B10, Q-B12 and Q-L1 (data location → archive provider).
2. **Hosted-Supabase spike** on a **disposable** Supabase project, created explicitly by the owner, never production. Run the integration suite, adapted to hosted endpoints, and confirm:
   - direct vs pooler (session mode) behaviour for COPY, `REPEATABLE READ READ ONLY` snapshots, `SET LOCAL` timeouts and long exports;
   - SSL `verify-full` with the Supabase CA;
   - creating least-privilege `monitor` and `archive` roles on hosted Postgres (BYPASSRLS availability, MAINTAIN, `pg_stat_*` visibility);
   - exact-count and growth-query cost on the Free/Nano compute;
   - batch-size and lock-timeout behaviour under a concurrent synthetic app load;
   - a Free-plan read-only-mode (disk-full) drill.
3. **Archive provider:** implement the chosen S3-compatible `ArchiveStore` (object lock/versioning, sha256 checks, private access, region per Q-L1). Test it with the existing verification gate. Document restore.
4. **Authentication and authorization** for the dashboard and API (Q-B12). Add an approval UI and API implementing the Q-B7 policy. Audit approver identity.
5. **Secrets:** move from `env:` to a managed secret store (`vault:`), with rotation, per-app least-privilege credentials, and no shared superuser.
6. **Operator runbooks:** kill switch, requires_review resolution, restore from archive, lease takeover, and pausing an application.
7. **Staged enablement**, each stage with sign-off:
   1. Stage 1: ARCHIVE_AND_VERIFY_ONLY against **RosiFit production read-only**, over several cycles. Compare previews, archives and restores.
   2. Stage 2: deletion on a **staging or disposable copy** of RosiFit data. Add `staging` to `DELETION_ALLOWED_ENVIRONMENTS` and set `ALLOW_DELETION=true` only on that worker.
   3. Stage 3: a code change (Phase 3C) to allow `production` in the allow-list. Then one small, approved, manually run production job with the safety copy (Q-B9), the kill switch within reach, and post-job reconciliation reviewed.
8. **Scheduling and notifications** remain separate later decisions. Enabling them requires a migration: their CHECK constraints currently force `false`.
