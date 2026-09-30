# Phase 2 — Architecture Decision Record

**UniqBotz Central Data Retention & Archive System**

| | |
|---|---|
| Status | **Proposed** — investigation complete, nothing implemented |
| Date | 2026-09-30 |
| Scope | Architecture for monitoring, candidate selection, archival, verification, deletion and audit across RosiFit, UniqBrio, Jalsa Restaurant and future applications |
| Supersedes | — |
| Primary source | `UniqBotz_Data_Retention_Detailed_Architecture_Flow.docx` (the "architecture document") |
| Secondary sources | Phase 1 code (`src/lib/domain`, `src/lib/data`), `README.md`, `AGENTS.md`, Supabase and provider documentation (cited inline) |

> **Phase 2 is analysis only.** This record creates no tables, migrations, connections, credentials, workers,
> queues, schedules, buckets, notifications or deletion code. Nothing here has been executed against any database.

---

## Contents

0. [How to read this document](#0-how-to-read-this-document)
1. [Context and Phase 1 baseline](#1-context-and-phase-1-baseline)
2. [Candidate freezing and exact record identity](#2-candidate-freezing-and-exact-record-identity)
3. [Whole-day archive algorithm](#3-whole-day-archive-algorithm)
4. [Late-arriving and backdated data](#4-late-arriving-and-backdated-data)
5. [Multi-table archiving and foreign keys](#5-multi-table-archiving-and-foreign-keys)
6. [Execution architecture options](#6-execution-architecture-options)
7. [Supabase Free Plan constraints](#7-supabase-free-plan-constraints)
8. [Archive storage](#8-archive-storage)
9. [Archive format and metadata](#9-archive-format-and-metadata)
10. [Archive verification](#10-archive-verification)
11. [Safe deletion](#11-safe-deletion)
12. [Job state machine and recovery](#12-job-state-machine-and-recovery)
13. [Database health and growth](#13-database-health-and-growth)
14. [Thresholds](#14-thresholds)
15. [Database capacity vs record count](#15-database-capacity-vs-record-count)
16. [Security](#16-security)
17. [Data privacy and personal data](#17-data-privacy-and-personal-data)
18. [Cost and complexity](#18-cost-and-complexity)
19. [Central vs sidecar vs hybrid](#19-central-vs-sidecar-vs-hybrid)
20. [Architecture attack](#20-architecture-attack)
21. [Decision matrix](#21-decision-matrix)
22. [Recommended Phase 2 architecture](#22-recommended-phase-2-architecture)
23. [Phase 3 implementation plan](#23-phase-3-implementation-plan)
- [Appendix A — Phase 1 contract changes implied by this record](#appendix-a--phase-1-contract-changes-implied-by-this-record)
- [Appendix B — Sources](#appendix-b--sources)
- [Phase 3A Validation Status](#phase-3a-validation-status)

---

## 0. How to read this document

Every statement is tagged by the kind of evidence behind it:

| Tag | Meaning |
|---|---|
| **[DOC]** | Stated in the architecture document. |
| **[P1]** | Already true in the Phase 1 code or UI. |
| **[FACT]** | Verified from current vendor documentation (source listed in Appendix B). |
| **[PG]** | Standard PostgreSQL behaviour. Documented upstream, but must still be confirmed on Supabase in a prototype. |
| **[INFERENCE]** | Architectural reasoning from the facts above. |
| **[ASSUMPTION]** | Believed true but not verified. Must be tested or confirmed. |
| **UNDECIDED** | The documents leave this open. It is **not** resolved here by assumption; options are listed. |

Decision IDs (`D-xx`) are used in the decision matrix (§21).

---

## 1. Context and Phase 1 baseline

### 1.1 System context

- The central platform is an **internal control plane**, not a customer dashboard. **[DOC §1]**
- Each application (RosiFit, UniqBrio, Jalsa Restaurant, future) is **independent**: its own Supabase project, database, schema, policies, archive history and credentials. **[DOC scope, §2]**
- One retention engine is reused; policies are **per application and per table**. **[DOC §2]**
- Only tables explicitly configured as **Archive** may enter the engine. Newly discovered or uncertain tables default to **Review Required**. **[DOC §2] [P1]**
- End-to-end flow **[DOC §18]**: Monitor → Detect threshold → Alert operator → Evaluate retention policy → Find oldest eligible day → Process complete days → Cross cumulative target → Freeze candidate set → Export archive → Verify archive → Delete exact verified records in batches → Verify deletion → Recheck database health → Audit → Notify.
- Design principle **[DOC §20]**: conservative. Unknown tables are untouched, verification is mandatory, deletion is limited to verified candidates, large jobs are resumable, and the execution architecture is chosen only after comparing native, external-worker, sidecar and hybrid approaches.

### 1.2 What Phase 1 already fixes (the product interface)

The Phase 1 UI is treated as the intended product interface. Relevant contracts:

| Area | Phase 1 contract | File |
|---|---|---|
| Data access | Everything goes through `InfrastructureDataSource`. A live implementation replaces `MockDataSource` in `createDataSource()`. | `src/lib/data/source.ts`, `DataProvider.tsx` |
| Thresholds | `recordThresholds {low 1,000,000, medium 1,100,000, high 1,200,000}`, inclusive (`>=`). | `src/lib/domain/severity.ts` |
| Capacity | `capacityThresholdsPct {70, 80, 90}`, explicitly labelled demo defaults, **not** business rules. | `src/lib/data/mock/settings.ts` |
| Whole-day rule | `selectWholeDays(days, target)`: ascending dates, whole days across all selected tables, stop at `>= target`. | `src/lib/domain/selection.ts` |
| Policies | `review_required` / `dont_archive` / `archive`, with `dateColumn`, `protectedPeriodMonths`, `archiveTargetRecords`, `enabled`. Only `archive` can be enabled. | `src/lib/domain/types.ts`, `src/lib/data/validation.ts` |
| Job statuses | `preparing, selecting, exporting, verifying, ready_for_deletion, deleting, completed, failed, requires_review` | `ArchiveJobStatus` |
| Pipeline steps | `candidate_selection, candidate_frozen, archive_created, archive_verified, deletion, deletion_verified, completed` | `PipelineStepKey` |
| Verification gate | `isDeletionAllowed(job)` requires `state === "passed"`, `checksumMatch === true` and `verifiedCount === expectedCount`. | `src/lib/domain/jobs.ts` |
| Deletion | `simulateDeletionConfirmation` refuses when verification has not passed and always returns `recordsDeleted: 0`. | `mockDataSource.ts` |
| Safety settings | `gracePeriodDays` (global, 7), `archiveVerificationRequired: true` (typed as the literal `true`), `deletionBatchSize` (2,000), `manualDeletionReviewRequired`. | `InfrastructureSettings` |
| Growth | 6-month average = Σ records added in the last 6 complete months ÷ Σ days in those months. | `src/lib/domain/health.ts` |

Phase 1 inconsistencies this record must resolve (not bugs; mock simplifications):

1. **"Candidate Frozen" is a pipeline step in Phase 1, not a job status.** The architecture document lists "Candidate boundary/freeze" as a state **[DOC §15]**. See §12.
2. **The Jalsa multi-table candidate uses each table's own date column** (`orders.order_date`, `order_items.created_at`, …). For foreign-key-related tables this can split a parent from its children. See §5.3.
3. **Mock job `JOB-00123` says "Children first: order_items → orders".** This is illustrative text. The order must come from the discovered dependency graph (§5), not a hard-coded rule.
4. **Grace period is global.** §4 recommends a per-table override.
5. **Mock archive locations use `demo://`** and sizes are invented. No provider is implied.

---

## 2. Candidate freezing and exact record identity

### 2.1 The invariant

> **I-1.** The set of rows deleted is a subset of the rows contained in the verified archive, and every deleted row was byte-for-byte unchanged since it was archived.

The architecture document requires "a reliable mechanism to identify exactly which records belong to the verified archive" that "must safely handle concurrent writes and guarantee that verified records are the records deleted" **[DOC §6]**. I-1 is stricter: it also covers rows that were *updated* between export and deletion.

### 2.2 The race that must be defeated

```
t0  Candidate selection: days 2023-09-01 … 2024-07-31 → 125,209 rows
t1  Export starts, rows streamed to archive
t2  App inserts a backdated attendance row dated 2024-07-15   (not in archive)
t3  App corrects a payment dated 2024-03-02                   (archive holds old version)
t4  Archive verified
t5  Deletion runs
```

A deletion expressed as a **predicate** (`WHERE attendance_date <= '2024-07-31'`) deletes the t2 row, which was never archived, and the t3 row, whose archived copy is stale. Both are silent data loss. **A date range is not an immutable candidate set.** **[INFERENCE]**

### 2.3 Approaches compared

#### (1) Exact record IDs, held in the job (manifest)

The frozen candidate set is the explicit list of primary keys (PKs) that were exported. Deletion addresses those PKs only.

- **Correctness:** Rows inserted after the freeze are never in the list, so they are never deleted. Updated rows are only caught if a row version check is added (see approach 7).
- **Concurrency:** Selection needs no locks. Deletion by PK uses index lookups.
- **Late/backdated rows:** Never deleted by this job. They stay behind as "stragglers" (§4.4).
- **Storage:** 125k PKs × (16 B UUID or 8 B bigint + 16 B hash) ≈ 3–4 MB raw, ≈ 2 MB compressed per job.
- **DB overhead:** Deletes of 2,000 PKs per statement with `= ANY($1)` are cheap on an indexed PK.
- **Recovery:** Deletion by explicit PK is naturally idempotent (a re-run deletes 0 extra rows).
- **Complexity:** Low to moderate.
- **Free Plan fit:** Good, **provided the list is not stored in the source database** (see 2.4).

#### (2) `archive_job_items` table

A relational form of (1): one row per candidate record, `(job_id, table_name, pk, row_hash, day, batch_no, state)`.

- Same correctness as (1). Adds per-row state (`pending / deleted / drifted / missing`) and queryable progress.
- **Where it lives decides whether it is viable:**

| Location | Verdict |
|---|---|
| Source app DB | **Rejected.** It writes ~10–20 MB (heap + index + WAL) into a database that is being archived *because it is near its 500 MB limit*. It also cannot be written while the DB is read-only (§7). |
| Central control-plane DB | Viable for small volumes. At 50 apps × ~35 jobs/yr × 125k rows it is ~220M rows/yr, which does not fit a Free database. Rows would have to be purged after each job. |
| Object storage (manifest file) | **Preferred.** No database cost. Immutable once written. Checksummed like the archive. |

#### (3) Deterministic range / watermark snapshot

The candidate is "rows with `date_col` in range AND `id <= max_id_at_freeze`", or AND `created_at <= freeze_ts`.

- **Correctness: unsafe on its own.** **[PG]**
  - Sequence values are allocated at `nextval()` time, not commit time. A transaction holding `id = 100` can commit *after* the freeze observed `max(id) = 105`. That row satisfies `id <= 105` but was not visible to the export.
  - `created_at DEFAULT now()` is the *transaction start* time, so the same gap exists for timestamp watermarks.
  - UUIDv4 primary keys have no order at all.
  - Client-supplied `created_at` values (imports, offline sync) can be anything.
- **Late/backdated rows:** A backdated row inserted after the freeze has a new id/created_at, so it is correctly excluded. The problem is rows inserted *during* the freeze window, and all updates.
- **Storage:** Minimal (two values per job).
- **Verdict:** Useful as a **pre-filter** and as a cross-check. **Not acceptable as the deletion predicate.**

#### (4) Snapshot boundary (persisted boundary date)

"Everything on or before 2024-07-31 has been archived." This is the "archive boundary" the architecture document asks to persist **[DOC §5]**.

- It is a **bookkeeping value, not a candidate set.** On its own it has every problem of (3), plus none of the protection.
- **Hidden risk:** If the next job starts from `boundary + 1`, then backdated rows dated ≤ boundary are never archived and live forever.
- **Verdict:** Persist it for audit and UI. **Next-job selection must start from the actual oldest eligible date in the table (`MIN(date_col)`), not from `boundary + 1`** (§3.9, §4.4).

#### (5) PostgreSQL transaction snapshot

Use one `REPEATABLE READ` transaction (optionally shared across connections via `pg_export_snapshot()` / `SET TRANSACTION SNAPSHOT`) so that export and deletion see the same rows. **[PG]**

- **Correctness:** Rows committed after the snapshot are invisible, so they are not deleted.
- **Fatal problems:**
  - Export → upload → *verification in external storage* → deletion would all have to happen inside **one open transaction**, potentially for tens of minutes.
  - A long-held snapshot pins the xmin horizon, which blocks vacuum on the whole database (bloat grows exactly when we are trying to shrink it).
  - The whole delete would become one giant rollback-able unit, which the architecture document explicitly avoids ("Avoid one massive DELETE") **[DOC §12]**.
  - Supavisor transaction mode cannot hold a session; session mode or direct connections are needed **[FACT]**.
  - The `postgres` role's statement timeout is capped by a 2-minute global default unless changed **[FACT]**.
- **Verdict:** **Use a snapshot for reading only**: one short `REPEATABLE READ READ ONLY` transaction to *produce* the frozen set consistently across all tables in a job. **Never hold it across verification or deletion.**

#### (6) Partition-based archiving

Declaratively partition large tables by the date column (e.g. monthly or daily). Archival becomes `DETACH PARTITION` → export → verify → `DROP TABLE`. **[PG]**

- **Correctness:** Very strong. A detached partition is frozen by construction.
- **Space:** `DROP` returns space to the OS immediately; `DELETE` does not (§7.4). This is the single biggest advantage.
- **Problems:**
  - Converting an existing table to a partitioned table is a schema migration **owned by each application team** (rewrite, PK must include the partition key, FK and unique-constraint implications).
  - The whole-day rule with a 125,000-row target does not align with fixed partitions. Monthly partitions split the target; daily partitions create hundreds of partitions.
  - A late insert into a detached range either fails (no partition) or lands in a default partition, which then has to be handled.
- **Verdict:** **Out of scope for Phase 3.** Keep as a future option for the highest-volume tables (e.g. Jalsa `orders`/`order_items`) if DELETE bloat proves unmanageable. This needs application-team agreement.

#### (7) Hybrid: snapshot-read freeze + exact-PK manifest + row-version guard (recommended)

1. **Select** (read-only aggregate): compute the whole-day boundary per §3.
2. **Freeze + export** in **one `REPEATABLE READ READ ONLY` transaction** across all tables in the job:
   - Stream every row for the selected days to the archive.
   - For each row, record `(pk, row_hash)` in a **manifest**, where `row_hash = md5(t::text)` is computed by Postgres in the same `SELECT`.
   - The frozen set *is* exactly the set of rows exported. There is no gap between "selected" and "exported".
3. **Verify** the stored archive against the manifest (§10).
4. **Delete** in batches, addressed by **PK and guarded by row hash**:

   ```sql
   -- illustrative only; nothing here is implemented
   WITH m(pk, h) AS (SELECT * FROM unnest($1::uuid[], $2::text[]))
   DELETE FROM public.attendance_records t
   USING m
   WHERE t.id = m.pk
     AND md5(t::text) = m.h          -- row unchanged since export
   RETURNING t.id;
   ```

5. **Reconcile** each batch: `requested = deleted + drifted (hash differs) + missing (already gone)`.

**Properties:**

| Case | Outcome |
|---|---|
| New or backdated insert after freeze | Not in manifest → never deleted. It becomes a straggler for a later job (§4.4). |
| Row updated after export | Hash differs → not deleted. Reported as **drifted**. Re-archived by a later job. |
| Row deleted by the app after export | Affects 0 rows. Reported as **missing**. Harmless. |
| Schema change (column added, dropped or retyped) | `t::text` changes → every row "drifts" → **0 deleted**. Fail-closed. |

- **Storage:** Manifest ≈ 2 MB compressed per 125k rows, in object storage. The central DB holds only job and batch metadata.
- **DB overhead:** One read pass for export, plus one indexed lookup and hash per deleted row.
- **Recovery:** Idempotent per batch (§11). A crash during export discards the attempt; nothing was deleted.
- **Complexity:** Moderate. It needs PK discovery, manifest streaming and batch reconciliation.
- **Free Plan fit:** Good. No objects are created in source databases. The only prerequisite is a least-privilege role (§16).

**Assumptions behind the recommendation** (each must be validated in a Phase 3 prototype):

- **A-1.** Every archivable table has a primary key (or a unique NOT NULL key). Tables without one are **not archivable** (validated at policy-save time). `ctid` is **never** acceptable as an identity because it changes on UPDATE and VACUUM FULL. **[PG]**
- **A-2.** `md5(t::text)` is stable for an unchanged row between export and deletion, within one Postgres major version and schema. It is **not** stable across major-version upgrades or type changes; that failure mode is fail-closed (0 deleted). The prototype must also check behaviour for `jsonb`, arrays, `numeric`, `timestamptz` under differing session `TimeZone`/`DateStyle` settings (the worker must pin them).
- **A-3.** A single `REPEATABLE READ READ ONLY` export of ~125k rows (~20–40 MB) finishes well inside a statement timeout that the archiver role can be granted (e.g. 10 min), on Nano compute. **Needs measurement.**
- **A-4.** MD5 is used as a change detector, not a security control. An attacker able to craft MD5 collisions inside application rows is out of the threat model. A stronger hash (`sha256(t::text::bytea)` via `pgcrypto` / `digest`) can replace it if available and fast enough.

**Decision D-01 (can be finalized now):** The deletion predicate is always *exact PK + unchanged row hash from the verified manifest*. It is never a date range, watermark or boundary.

**Decision D-02 (can be finalized now):** The manifest and all per-row job data live **outside** the source database.

---

## 3. Whole-day archive algorithm

### 3.1 The rule (unchanged)

"Start at the oldest eligible date. Process dates in ascending order. For each date include all eligible records from every selected archive table. Add the complete day's records to the running total. Continue until the target is reached or crossed. Never take only part of a day." **[DOC §5] [P1 `selectWholeDays`]**

Worked example **[DOC §5]**: before July 31 = 124,999; July 31 = 60 + 70 + 80 = 210; archive 125,209, not 125,000.

### 3.2 Efficient calculation

Per table, one aggregate query over eligible rows only:

```sql
-- illustrative: $tz = application time zone, $cutoff = eligibility cutoff (§4)
SELECT (date_col AT TIME ZONE $tz)::date AS day, count(*) AS n
FROM   public.<table>
WHERE  date_col <  $cutoff              -- sargable: compared on the raw column
  AND  date_col IS NOT NULL
GROUP  BY 1
ORDER  BY 1
LIMIT  $maxDays;                        -- bounded scan; see below
```

- The worker merges per-table daily counts by date in memory (≤ a few hundred rows per table) and applies `selectWholeDays`. The existing Phase 1 function can be reused unchanged.
- **Early stop:** Days are ascending, so the scan can be limited. For example, fetch 120 days at a time and stop once the running total crosses the target. This avoids aggregating years of history each time.
- **Index:** A B-tree index on `date_col` makes both the aggregate and the export range scans cheap. Whether each table has one is **per-table evidence to collect**. Without an index, a 1M-row sequential scan on Nano is probably seconds, not minutes, but this **needs measurement** (A-3).
- **Predicates must be sargable.** Compare the raw column against day boundaries computed in the application time zone (`date_col >= '2024-07-31 00:00+05:30' AND date_col < '2024-08-01 00:00+05:30'`), not `(date_col AT TIME ZONE …)::date = …`, unless an expression index exists.

### 3.3 Exact or estimated counts

- **Selection and freeze counts must be exact.** Target crossing and verification depend on them. `pg_class.reltuples` and `pg_stat_user_tables.n_live_tup` are **estimates** and must never feed selection. **[PG]**
- **Health monitoring may use estimates** (§13.4), labelled as such.
- The **authoritative count is the frozen manifest count**. The selection count is a plan. They can differ if rows are inserted, deleted or backdated between selection and freeze. The job records both, and the UI shows the frozen count as "Selected (frozen)" (Phase 1 already does this).

### 3.4 Multi-table aggregation

- The daily total is the sum over the selected tables for that day (Phase 1 behaviour).
- **For foreign-key-related tables, per-table date columns are not safe.** A child row's own date can differ from its parent's (e.g. `order_items.created_at` vs `orders.order_date` at midnight), which splits an order from its items. For such groups the **root table's date column decides the day**, and child rows are included by FK closure (§5.3). The Jalsa mock must change accordingly (Appendix A).
- For **unrelated** tables archived together (e.g. `orders` and `audit_logs` with no FK), each table uses its own configured date column. Whether unrelated tables should share one job at all is **UNDECIDED** (§5.6).

### 3.5 Date-column selection

- The column must be of type `date`, `timestamp` or `timestamptz`. **Text columns holding dates are not accepted** (malformed values cannot be ordered safely). Enforced at policy-save time.
- `timestamp without time zone` is ambiguous: its time zone meaning is an application convention. **UNDECIDED per table**; the policy must record the assumed zone.
- Choosing *which* column (event date vs `created_at`) is covered in §4.3.

### 3.6 Time zone

- A "day" must be defined in a stated time zone. All three applications appear to be India-based, which suggests `Asia/Kolkata` (UTC+05:30, no DST). **[ASSUMPTION]**
- **UNDECIDED:** the business time zone per application. The default proposal is an application-level setting defaulting to `Asia/Kolkata`, recorded in every manifest.
- A UTC day boundary would split Indian business days at 05:30 IST. This is the kind of silent inconsistency the whole-day rule exists to prevent.

### 3.7 NULL dates, malformed dates, future dates

| Case | Proposed handling |
|---|---|
| `date_col IS NULL` | **Never eligible.** Counted and shown as "rows without a date (not archivable)". A NULL-date policy is **UNDECIDED** (e.g. fall back to `created_at`). |
| Malformed | Impossible with typed columns (3.5). Out-of-range values (year 1900, 9999) are eligible or not by the same comparison. The worker should report dates before the application's `registeredAt` as **suspicious**, not silently archive them. |
| Future dates (e.g. `reservations.reserved_for`) | Never eligible, because the cutoff is in the past. |

### 3.8 Duplicates, concurrent inserts, rows created after selection

- **Duplicate business records** (two identical rows with different PKs) are distinct rows. They are archived and deleted as rows. Deduplication is not a retention concern.
- **Duplicate PKs in the archive** (a retry bug) are caught by verification (§10: PK uniqueness check).
- **Concurrent inserts during selection:** Harmless. Selection is a plan; the freeze snapshot decides.
- **Rows inserted after the freeze:** Excluded by construction (§2.3 (7)).

### 3.9 Where the next selection starts

The architecture document says "Persist the last completed date as the next archive boundary" **[DOC §5]**. This record interprets that as:

- **Persist** the boundary (for UI, audit and restore lookup).
- **Start the next selection at the actual `MIN(date_col)` among eligible rows**, which may be *before* the boundary if stragglers exist (§4.4).

Starting at `boundary + 1` would leave backdated rows behind forever. **[INFERENCE]**

### 3.10 When no complete day allows the target to be reached — UNDECIDED

Phase 1 already surfaces this state ("Target not reached — decided in the backend phase").

| Option | Behaviour | Pros | Cons |
|---|---|---|---|
| A. Do nothing (report only) | Candidate marked *insufficient*; no job. | Safest. Fewest jobs. | A storage-critical DB may still need relief (§15). |
| B. Archive all eligible whole days anyway | Job below target. | Relieves pressure. | Many small jobs; target loses meaning. |
| C. Wait / accumulate | Re-evaluate daily until the target is reachable. | Keeps job sizes uniform. | Same as A in the short term. |
| D. Operator decides per candidate | UI offers "archive below target" with justification. | Flexible and audited. | Needs a UI state and an approval rule. |

**Recommendation for the product decision:** A by default, plus D as an explicit, audited override when capacity severity ≥ MEDIUM. **This requires business confirmation. It is not implemented.**

### 3.11 Oversized single day — UNDECIDED

If one day alone holds far more than the target (e.g. a 300,000-row bulk import), the whole-day rule archives the entire day.

- **Option 1:** Allow it. Streaming and batching handle size, so this is the default reading of the rule.
- **Option 2:** Cap job size and require review. This conflicts with "never split a day".

**Needs business confirmation.** Technically, only duration and storage grow.

---

## 4. Late-arriving and backdated data

### 4.1 What changes with exact-PK freezing

With §2.3 (7) in place, **late data is no longer a data-loss risk.** A row that arrives after the freeze can never be deleted by that job. **[INFERENCE]**

Late data becomes a **completeness and fragmentation** concern: rows for day D may end up spread across two archives, or remain in the source database after "day D was archived". The grace period exists to reduce that fragmentation, not to protect deletion.

### 4.2 Eligibility cutoff

```
eligible  ⇔  date_col  <  start_of_day( today_in_app_tz − protectedPeriod − graceDays )
```

- `protectedPeriod` is per table **[P1 `protectedPeriodMonths`]**.
- `graceDays` is currently global **[P1 `gracePeriodDays = 7`]**.
- **Recommendation D-07:** keep the global default and add an **optional per-policy override**. It should be allowed to be larger for tables known to receive imports.
- With 6–24-month protected periods, a 7–30-day grace changes the cutoff by only 1–15 %. Its practical effect is small. It matters most for tables with short protected periods (e.g. UniqBrio `notification_logs`, 6 months).

### 4.3 Which date column

| Column | Meaning | Reliability | Retention fit |
|---|---|---|---|
| Event date (`attendance_date`, `order_date`, `paid_at`) | When the business event happened | Can be backdated or corrected by users and imports | **Best semantic fit** ("keep 12 months of attendance") |
| `created_at` (DB default) | When the row was inserted | Immutable if DB-defaulted. Unreliable if client-supplied. | Wrong for imports: a 2-year-old import looks brand new. |
| `updated_at` | Last change | Changes on every correction | **Never use for eligibility.** It would reset retention on a trivial edit. |

- **Recommendation (D-06):** the date column stays **configurable per table** **[P1]**. Prefer the event date where one exists and is typed and non-null.
- Optionally add a **"settled" guard**: require *both* the event date past the cutoff *and* `created_at` (or `updated_at`) older than `graceDays`. This keeps freshly imported historical rows and freshly corrected old rows until they have settled.
- Whether to enable the guard is per table. It needs the evidence below.

### 4.4 Stragglers

A **straggler** is an eligible row whose date is ≤ a previous boundary but which was not archived, because it arrived or changed after that job's freeze.

- They are picked up automatically by the next selection, because selection starts at `MIN(date_col)` (§3.9).
- The next archive then contains a few old days plus new days. The manifest records every day covered, so restore lookups by date must consult **all** manifests overlapping that date (§9.4).
- Straggler counts per table should be shown in the UI. A persistently high count is the evidence that the grace period is too short.

### 4.5 Evidence needed before choosing grace values

Grace values should come from measurements, not guesses. Per table, over the last 6–12 months:

```sql
-- illustrative
SELECT percentile_disc(ARRAY[0.5, 0.95, 0.99, 1.0])
         WITHIN GROUP (ORDER BY created_at - event_date) AS lag
FROM   public.<table>
WHERE  created_at >= now() - interval '12 months';
```

Also needed:

- Counts of rows updated more than N days after creation, where `updated_at` exists.
- Known business processes, per application team: offline attendance sync, CSV imports, payment reconciliation windows, manual correction windows. **Only the application teams can confirm these.**

The grace value should exceed the observed p99 lag with margin. **No value (7, 14 or 30 days) is declared correct here.** Until evidence exists, the Phase 1 default of 7 days stands as a placeholder.

---

## 5. Multi-table archiving and foreign keys

### 5.1 Discovering the dependency graph

Discovery must be dynamic, read from the catalog of each application database, and repeated at every job start, not only at policy-save time. **[PG]**

```sql
-- illustrative
SELECT c.conname,
       c.conrelid::regclass  AS child,
       c.confrelid::regclass AS parent,
       c.confdeltype         -- a = no action, r = restrict, c = cascade, n = set null, d = set default
FROM   pg_constraint c
WHERE  c.contype = 'f';
```

Also discover:

- **Triggers** on candidate tables (`pg_trigger WHERE NOT tgisinternal`). An `AFTER DELETE` audit trigger could insert one audit row per deleted row, *growing* the database during cleanup.
- **Rules** (`pg_rules`).
- **References into or out of other schemas** (e.g. `auth.users`).
- **Self-references** (e.g. `comments.parent_id`) and **cycles**.

### 5.2 What the graph must enforce

| FK action from a candidate parent to a child | Risk if parent rows are deleted | Rule |
|---|---|---|
| `NO ACTION` / `RESTRICT` | Delete fails while children exist (fail-closed). | Allowed. The child table must be in the job group, or the job reports "blocked by children". |
| **`CASCADE`** | **Children are deleted silently and are not in the archive → data loss.** | **Blocked** unless the child table is in the same job group *and* every child row referencing a candidate parent is itself in the manifest (checked before deletion). |
| `SET NULL` / `SET DEFAULT` | Children are **modified** silently. Their archived state no longer matches, and the modification is not archived. | **Blocked** unless the child is in the group (same check as CASCADE). |

Deletion order is derived as a **reverse topological order** of the group's FK graph. "Children first" is only the *result* when edges actually point that way; it is never hard-coded (correcting Phase 1 mock text, §1.2).

- **Cycles:** block and require review.
- **Self-FKs:** delete leaf rows first within the table, or block if depth is unknown.

### 5.3 Root-driven groups (orphan prevention)

For FK-related tables (e.g. Jalsa `orders` → `order_items`, possibly `payments`):

- The group has a **root table** whose date column defines the day.
- Children are selected by FK closure (`order_items WHERE order_id IN frozen orders`), **not** by their own date column.
- Deletion runs per batch of root PKs, in one short transaction: delete the children of those roots, then the roots. The application never observes an order without its items. **[INFERENCE]**
- A child row created *after* the freeze that references a frozen parent is detected at deletion time: with `NO ACTION` the parent delete fails, which is safe. That batch is marked drifted and retried by a later job.

Whether `payments` belongs to the `orders` group depends on the **actual** FK graph, which Phase 2 cannot see. **Unknown until discovery runs.**

### 5.4 Tables selected independently

A table with no FK edges to other candidate tables (e.g. `audit_logs` with a free-text `entity_id`) can be archived alone.

Undeclared, application-level relationships (a column holding another table's id without an FK) are **invisible to discovery**. The policy editor needs a way for an operator to declare "logical relationship, archive together". **UNDECIDED whether to support this in Phase 3.**

### 5.5 Tables that must not be archived together

- Tables in different applications can never share a job: separate databases, so no single snapshot.
- A group spanning an FK edge whose other side is *not* archivable (e.g. a child of `members`, whose policy is Don't Archive) can archive the child only.
- The parent can never be archived while children with `NO ACTION` still reference it.

### 5.6 Validation

At policy save, and again at job start:

1. The PK exists (A-1).
2. The date column is typed.
3. Graph discovery is run.
4. Any CASCADE / SET NULL edge touching a candidate table not in the group is rejected.
5. Triggers are listed and the operator must acknowledge them.
6. A **graph hash** is stored in the job. If the hash at deletion time differs, deletion stops before the first batch (fail-closed).

**UNDECIDED:** whether one job may contain *unrelated* tables (Phase 1's Jalsa preview combines `orders` with `audit_logs`). It is technically possible and gives one shared target. Separate jobs are simpler to reason about and recover. This is a product choice.

---

## 6. Execution architecture options

The architecture document requires comparing four execution models before choosing **[DOC §13]**. Workload profile per job (from Phase 1 mock scale, **[ASSUMPTION]** until measured):

- read ~125k rows (~20–40 MB uncompressed)
- write ~5–15 MB compressed
- hash every row
- run ~60 delete batches

Jobs happen roughly weekly to monthly per high-volume table. Health checks happen every few minutes to hourly per application.

### Option 1 — Supabase-native

pg_cron + SQL/RPC in each application database for selection and deletion. Edge Functions for export. Supabase Storage or Vault as needed.

| Criterion | Assessment |
|---|---|
| Reliability | Weak for heavy work. Edge Functions on Free have **150 s wall clock, 2 s CPU per request, 256 MB memory** **[FACT]**. Gzip and hashing of a 20–40 MB export would need to be split across many invocations with external checkpointing, which is re-implementing a worker badly. |
| Free Plan fit | Cron recommends **≤ 8 concurrent jobs, each ≤ 10 minutes** **[FACT]**. Runs log to `cron.job_run_details`, and pg_net responses land in tables, **both of which consume the database we are trying to shrink**. |
| CPU/memory | Shares the application's own Nano compute (shared CPU, 0.5 GB RAM) **[FACT]**. Archive work competes with production traffic. |
| Network | Edge Function to DB to Storage is in-platform, but egress still counts toward the org quota **[FACT]**. |
| Failure recovery | Poor visibility. A killed function returns 546 **[FACT]**. Retries must be hand-built in SQL. |
| Security | Good: nothing leaves the platform. But archive logic must be **installed into every application database** (functions, cron entries, grants), which couples the retention system to each app's migrations. |
| Ops complexity | High per app (N copies of SQL and functions to version and migrate). |
| Cost | Lowest cash cost. |
| Scalability | Linear per-app deployment effort. |
| Future maintenance | Drift between N installed copies is likely. |

**Verdict:** Not suitable as the primary execution engine. Using **pg_cron in a central control-plane project for scheduling only** is still reasonable.

### Option 2 — Central external worker

One worker process, outside Supabase, connects to every application database, streams exports, uploads, verifies and deletes. The dashboard is a separate component.

| Criterion | Assessment |
|---|---|
| Reliability | Good. No platform time limits. Can checkpoint and resume. |
| Free Plan fit | Good. Nothing installed in app DBs except a login role. Must connect via **Supavisor** because Free direct connections are **IPv6-only**; Supavisor session mode (5432) supports IPv4 **[FACT]**. Session-level `statement_timeout` needs session mode or direct connections, not transaction mode **[FACT]**. |
| CPU/memory | Worker's own. Streaming keeps memory small (tens of MB). |
| Network | ~30–50 MB read per job from Supabase counts toward the **per-organization** 5 GB egress quota **[FACT]**. Upload goes to object storage; verification re-downloads the object (free for some providers, §8). |
| Failure recovery | Job leases + checkpoints (§12). |
| Security | **The worker holds credentials for every application** (largest blast radius of all options). Mitigated by least-privilege roles and per-app secrets (§16). |
| Ops complexity | One deployable. |
| Cost | One small always-on or scheduled compute unit. |
| Scalability | Jobs are independent; one worker can run them sequentially, several workers can use a lease queue. |
| Future apps | Add a registry row + a role + a secret. No new deployment. |

**Candidate worker environments (not selected here — selection criteria in §22):**

| Environment | Notes |
|---|---|
| Small VPS / VM (ideally Mumbai region) | Full control, always-on, IPv4+IPv6. Needs OS patching. |
| Container PaaS (Fly.io, Render, Railway, …) | Easy deploys. Several are IPv4-only (Supabase lists **Render** as IPv4-only **[FACT]**), so use the pooler. |
| Serverless jobs (Cloud Run Jobs, ECS Fargate tasks) | Pay-per-run. Good fit for batch work. More cloud setup. |
| AWS Lambda | 15-min cap **[ASSUMPTION]**. Workable only with checkpointed steps. |
| GitHub Actions scheduled workflow | Free-ish and already available. **IPv4-only** **[FACT]**. Schedules are best-effort. Secrets live in GitHub. Mixing CI with production data deletion is a governance concern. |
| Supabase Edge Functions | Rejected for heavy work (limits above). Acceptable for light health checks. |

### Option 3 — Per-application sidecar worker

Each application gets its own lightweight worker deployment, holding only that application's credentials.

| Criterion | Assessment |
|---|---|
| Reliability | Same per worker as Option 2. |
| Free Plan fit | Same connection constraints ×N. |
| Security | **Best isolation**: a compromised worker exposes one app. |
| Ops complexity | N deployments, N secret stores, version drift, N monitors. |
| Cost | N small compute units, which dominates cost at 10–50 apps. |
| Scalability | Deployment effort grows linearly. |
| Future apps | Each new app needs a new deployment. |

**Verdict:** Isolation benefit is real, but at 3 apps it does not justify the operational multiplication. Keep as an **upgrade path for a specific high-risk app**. The same worker image can run in "single-app mode".

### Option 4 — Hybrid

A **central control plane** owns policies, monitoring data, job metadata, scheduling, approvals and audit. A **stateless worker** (central by default, per-app optional) performs export, compression, checksum, verification and deletion, pulling work from the control plane.

This is Option 2 with an explicit separation of concerns:

- The control plane never touches application data.
- The worker never decides policy; it executes a signed/recorded job spec and reports every step back.
- The worker is replaceable (e.g. moved to a sidecar per app) without changing the control plane or UI.

Criteria as Option 2, plus:

- **Clear audit boundary:** all decisions are in the control plane, all effects are in the worker.
- **The browser only ever talks to the control plane** (§16).

**Assessment of the central question** — "the smallest reliable architecture that can safely support RosiFit, UniqBrio, Jalsa and future applications without hitting Free Plan limitations or creating unnecessary complexity" **[DOC §13]**: **Option 4 with a single central worker** (§22). Options 1 and 3 fail on reliability and on operational cost respectively.

---

## 7. Supabase Free Plan constraints

Verified from Supabase documentation on 2026-09-30 (sources in Appendix B).

**Research note:** the Supabase pricing page itself could not be loaded from this environment. Plan quotas below come from Supabase's billing and usage documentation pages. Re-check before relying on any single number.

### 7.1 Verified facts

| Topic | Fact | Tag |
|---|---|---|
| Database size limit | Free plan: **500 MB database size** (not disk size). Disk is 1 GB. | [FACT] |
| Over the limit | Project enters **read-only mode**: `cannot execute INSERT in a read-only transaction`. **Deletes are also blocked.** Manual escape: `set session characteristics as transaction read write;` → delete → `vacuum;` → `set default_transaction_read_only = 'off';` | [FACT] |
| Size measurement | Dashboard figure = `sum(pg_database_size(...))`. Includes tables, indexes and materialized views. Disk size = database size + WAL + system logs. Disk metrics update **daily**. New projects start at ~40–60 MB. | [FACT] |
| Fair use | Repeatedly exceeding Free quotas can lead to pausing, read-only mode or HTTP 402 on API requests. | [FACT] |
| Pausing | Free projects with low activity over **7 days** are paused. Restorable for 90 days. | [FACT] |
| Project count | **2 active free projects** per user, counted across every org where the user is Owner/Admin. Paused projects do not count. | [FACT] |
| Egress | 5 GB uncached + 5 GB cached **per organization**. Includes Database, Supavisor ("Shared Pooler Egress"), Storage, Edge Functions, Realtime. | [FACT] |
| Storage | 1 GB. **Max file size 50 MB** on Free. | [FACT] |
| Edge Functions | 256 MB memory, **150 s wall clock** (Free), **2 s CPU** per request, 150 s idle timeout, 500k invocations/month. | [FACT] |
| Compute | Nano: shared CPU, up to 0.5 GB RAM. **60 max DB connections, 200 pooler clients.** "Subject to change." | [FACT] |
| Timeouts | `anon` 3 s, `authenticated` 8 s, `service_role` falls back to 8 s, `postgres` capped by a **2 min global default**. Per-role change via `ALTER ROLE … SET statement_timeout`. Session-level change only via session-mode pooler or direct connection. | [FACT] |
| Cron | Supabase Cron (pg_cron). Recommends **≤ 8 concurrent jobs, each ≤ 10 min**. Run history in `cron.job_run_details`. Explicit Free-plan availability statement not found. | [FACT] / availability [ASSUMPTION] |
| pg_net | Async HTTP from SQL. Responses kept 6 h in unlogged tables. | [FACT] |
| Vault | Encrypted secrets extension; key held outside the DB. Listed as available "for every project", status public alpha. | [FACT] |
| Backups | **Free plan: no downloadable backups.** Supabase recommends Free users run `supabase db dump` and keep off-site backups. PITR is a paid add-on. | [FACT] |
| Connectivity | Free direct connections are **IPv6-only**. Supavisor (session 5432 / transaction 6543) is IPv4. The IPv4 add-on is paid. GitHub Actions, Vercel and Render are listed as IPv4-only. | [FACT] |
| Data API | Max 1,000 rows per request by default (configurable). | [FACT] (search excerpt) |
| API keys | New `sb_publishable_…` / `sb_secret_…` keys are recommended. The secret key uses `service_role` and bypasses RLS. Legacy JWT keys still work. **Custom login roles are supported and recommended per service.** | [FACT] |
| VACUUM | "Postgres does not immediately reclaim the physical space used by dead tuples." `VACUUM FULL` locks the table. **pg_repack is available** (online; needs a PK or unique NOT NULL index and **~2× the table + indexes in free disk**). Disk auto-scaling is paid-only; disk can grow but not shrink. | [FACT] |

### 7.2 Consequences for this architecture

1. **Act well before 500 MB.** Once read-only, the archiver's own `DELETE` fails. The only recovery is the manual escape above, which is an emergency procedure, not a normal path. Capacity alerts must fire early (§15). **[INFERENCE]**
2. **The archive is the only copy.** Free projects have no downloadable backups **[FACT]**. After deletion, the verified archive is the *only* copy of those rows. This raises the bar for verification (§10) and archive durability (§8), and argues for a **pre-deletion safety dump**. Whether that is required is **UNDECIDED** (§21).
3. **Project count is a hard constraint.** RosiFit, UniqBrio, Jalsa and a central control-plane project are **four** projects. With 2 active free projects per Owner/Admin, they cannot all be Free under one owner. **Requires business input** (§21): which projects are paid, or who owns which.
4. **Egress is per organization.** Several apps in one org share one 5 GB quota. Archive reads are small (tens of MB per job) but health checks must be cheap (catalog statistics, not full scans).
5. **Worker connectivity:** use Supavisor **session mode** (IPv4, supports session settings and `REPEATABLE READ` transactions).
6. **Pausing:** the central control-plane project is used by the worker continuously, so it is unlikely to idle **[INFERENCE]**. Application projects are active by definition.
7. **Timeouts:** the archiver role needs an explicit `statement_timeout` sized from prototype measurements (A-3). The 2-minute default may be too short for a single-snapshot export.
8. **Compute sharing:** archive work runs on the same Nano instance as production. Batch pacing (§11) protects production latency.

### 7.3 Measuring database and table size

Catalog queries are cheap and give sizes without scanning data **[PG]**:

- `pg_database_size(current_database())` for the database total.
- `pg_total_relation_size(oid)` (heap + indexes + TOAST).
- `pg_relation_size`, `pg_indexes_size` and `pg_stat_user_tables` (`n_live_tup`, `n_dead_tup`, `last_autovacuum`).

Include **non-`public` schemas**: `auth`, `storage`, `cron`, `net`, `supabase_migrations`, etc. **[INFERENCE]** Supabase CLI equivalents: `supabase inspect db table-sizes | bloat | vacuum-stats` **[FACT]**.

### 7.4 DELETE, dead tuples and VACUUM

- `DELETE` marks rows dead. Space becomes reusable **inside the table** after (auto)vacuum, but files are rarely returned to the OS. Plain `VACUUM` only truncates empty pages at the *end* of a table. **[PG] [FACT]**
- **Therefore `pg_database_size` usually does not drop after an archive job.** It plateaus while new inserts reuse the freed space. **[INFERENCE]**
  - Example: Jalsa `orders` grows ~3,240 rows/day in the Phase 1 mock. A 125k-row job frees space equal to **~39 days of that table's growth**.
- `VACUUM FULL` rewrites the table under an **ACCESS EXCLUSIVE** lock and needs free disk for the copy. That is dangerous exactly when the disk is near full. **[PG] [FACT]**
- `pg_repack` avoids the long lock but needs ~2× table size free **[FACT]**. Only feasible for small or medium tables on a 1 GB disk.
- **The UI must never promise that archive reduces "database size" immediately.** Phase 1 already notes this on the Database Health page.

---

## 8. Archive storage

**Research note:** all prices below are **indicative**, from search excerpts and third-party pages. Official pricing pages could not be loaded from this environment. **Re-check before any commitment.** Features marked [FACT] were confirmed from provider documentation excerpts.

| | AWS S3 (Mumbai) | Cloudflare R2 | Backblaze B2 | Wasabi | GCS (Mumbai) | Supabase Storage |
|---|---|---|---|---|---|---|
| Storage price | ~$0.025/GB-mo Standard; IA/Glacier IR cheaper (indicative) | $0.015/GB-mo [FACT] | ~$0.007/GB-mo (reported 2026 increase; indicative) | ~$0.008/GB-mo, **1 TB minimum charge** [FACT] | ~$0.02x/GB-mo (indicative) | Free 1 GB; then Pro plan pricing [FACT] |
| Egress | First 100 GB/mo free across AWS [FACT], then per GB | **Free** [FACT] | Free up to 3× stored, then $0.01/GB [FACT] | No fee within fair use [FACT] | Per GB | Counts toward org egress quota [FACT] |
| Minimum duration | None (Standard); 30 d (IA), 90 d (Glacier IR) [FACT] | None (Standard) [FACT] | None found | **90 days** [FACT] | None (Standard) | None |
| Free tier | Credits-based for new accounts [FACT] | 10 GB-month [FACT] | 10 GB [FACT] | Trial only | Not in Mumbai [FACT] | 1 GB, 50 MB max file [FACT] |
| S3 API | Native | Yes [FACT] | Yes [FACT] | Yes [FACT] | Partial (interop) | Yes (SigV4) [FACT] |
| Versioning | Yes | Not found | Yes [FACT] | Yes | Yes [FACT] | **No** [FACT] |
| Object lock / WORM | Object Lock (governance/compliance) [FACT] | Bucket Locks (prefix retention) [FACT] | Object Lock [FACT] | Object Lock (set at bucket creation) [FACT] | Bucket Lock, Object Retention Lock [FACT] | **No** [FACT] |
| Lifecycle rules | Yes [FACT] | Yes [FACT] | Yes [FACT] | Yes [FACT] | Yes [FACT] | **No** [FACT] |
| Encryption at rest | Default SSE-S3; SSE-KMS with customer keys [FACT] | Default AES-256; SSE-C [FACT] | **Opt-in per bucket**; SSE-C [FACT] | Default; SSE-C [FACT] | Default; CMEK/CSEK [FACT] | Default; no SSE headers or CMK [FACT] |
| **India data location** | **Yes (ap-south-1)** | **No** (EU/US/FedRAMP jurisdictions only) [FACT] | **No** [FACT] | **No** (nearest Singapore) [FACT] | **Yes (asia-south1)** | **Yes, if the project is in ap-south-1** [FACT] |
| Durability (published) | 11 nines [FACT] | 11 nines [FACT] | 11 nines [FACT] | 11 nines [FACT] | 11 nines [FACT] | Not published |
| Presigned URLs | Yes | Yes [FACT] | Yes | Yes | Yes (V4 signed) | Yes [FACT] |
| Ops complexity | Medium (IAM) | Low | Low | Low (minimums) | Medium (IAM) | Lowest (same platform) |

### 8.1 Observations

- **Volume is small** (§18): ~0.3–1 GB/year compressed for the three apps, ~10–20 GB/year at 50 apps. **Storage price is not the deciding factor.** Wasabi's 1 TB minimum makes it a poor fit at this scale. **[INFERENCE]**
- **Data location is the deciding factor, and it is a business/legal question** (§17). If archives of Indian users' personal data must stay in India, the only options are:
  - S3 Mumbai
  - GCS Mumbai
  - Supabase Storage in an ap-south-1 project

  R2, B2 and Wasabi drop out.
- **Supabase Storage** lacks versioning, lifecycle and object lock, and has a 50 MB per-file limit on Free (archives must be split into parts). It also shares the Supabase account and failure domain with the source data. The architecture document asks for **external** private storage **[DOC §10]**. Acceptable for a **Phase 3 prototype only**, not for production archival.
- **Object Lock tension:** WORM protects archives from deletion by an attacker or mistake, but **permanent deletion from the archive may be legally required** (erasure requests, retention expiry; §17). Governance-mode locks (removable by privileged users) or versioning + lifecycle are the likely compromise. **UNDECIDED.**

**Decision:** provider **not finalized**. It depends on the data-location answer (Q-L1 in §21). Recommended shortlist:

- **If India residency is required:** AWS S3 ap-south-1, or GCS asia-south1.
- **If it is not required:** Cloudflare R2, for zero egress, simple ops and a free tier. B2 is a close alternative.

---

## 9. Archive format and metadata

### 9.1 Formats compared

| | CSV.GZ (Postgres `COPY … CSV`) | JSONL.GZ (`row_to_json`) | Parquet | XLSX |
|---|---|---|---|---|
| Size (compressed) | Small | Larger (keys repeated per row; gzip mitigates) | **Smallest** (columnar + typed encodings) | Large, ZIP-XML |
| Streaming write | **Native** (`COPY TO STDOUT` → gzip → multipart upload) | Easy | Buffers row groups (bounded memory) | Poor (library-dependent, memory-heavy) |
| Schema preservation | Column names only; types live in a sidecar schema file | Partial (JSON types; dates as strings; `numeric` precision risk) | **Strong** (typed schema embedded) | Weak (Excel coerces values) |
| Restoration to Postgres | **Exact round-trip via `COPY FROM`** with the same column list, including NULL vs empty string **[PG]** | `jsonb_populate_recordset` or app code | Needs tooling (DuckDB, pyarrow, …) | Manual |
| Human readability | Good after gunzip | Good | Needs tools | **Best** |
| Excel | Opens after gunzip; 1,048,576-row limit; encoding quirks | No | No | Native, same row limit |
| Implementation complexity | **Lowest** | Low | Medium (extra dependency) | Medium to high |
| Large datasets | Good | Good | **Best** | Unsuitable |

**Recommendation (D-12):**

- **Primary archival format: CSV.GZ produced by Postgres `COPY … TO STDOUT (FORMAT csv, HEADER)`**, split into parts of ≤ 50,000 rows. Reasons: exact Postgres round-trip, streaming, least code, and it matches the Phase 1 default.
- **Accompany every archive with a machine-readable schema file and manifest** (9.2), so type information is never lost.
- **Parquet** is a later optimization for analytics. **XLSX is only an on-demand, human-facing export** of small subsets, never the archive of record. **[DOC §9]**
- **Needs prototype:** a round-trip test (export → restore into a scratch DB → `md5(row::text)` equality) covering `jsonb`, arrays, `bytea`, `numeric`, `timestamptz`, enums and NULL vs empty string.

### 9.2 Metadata accompanying every archive (yes, always)

Each job writes, next to the data parts:

**`manifest.json`** (small, human-readable):

- Identity:
  - format version
  - `application_id`, application name
  - Supabase project ref
  - database identifier (`system_identifier` from `pg_control_system()` if permitted, plus `current_database()`)
  - Postgres server version
- Job:
  - job ID and attempt number
  - worker version
  - created by
  - approvals (IDs and timestamps)
  - creation timestamp (UTC)
- Selection:
  - policy snapshot (date column, protected period, grace, target, time zone)
  - eligibility cutoff
  - archive boundary (first day, last day)
  - list of covered days with per-table counts (includes straggler days)
- Per table:
  - schema-qualified name
  - PK columns
  - row count
  - part files with row counts, byte sizes and SHA-256 of each compressed part
- Row hash:
  - algorithm (`md5(t::text)` or `sha256`)
  - pinned session settings (`TimeZone`, `DateStyle`, `extra_float_digits`, `bytea_output`)
- FK graph hash and deletion order
- Manifest-of-hashes digest: SHA-256 over the sorted `(table, pk, row_hash)` lines

**`schema.json`:** column names, types, nullability, defaults, constraints and indexes as read from `pg_catalog` at freeze time.

**`keys/<table>.csv.gz`:** `(pk, row_hash)` per row. This is the deletion manifest (§2.3 (7)).

### 9.3 Object layout (proposal)

```
<bucket>/<application_id>/<schema>.<table-or-group>/<yyyy>/<job_id>/attempt-<n>/
    manifest.json
    schema.json
    data/<table>/part-00001.csv.gz …
    keys/<table>.csv.gz
```

- Attempts are isolated. A retried export writes a new `attempt-<n>` prefix, and only the verified attempt is referenced by the job.

### 9.4 Restore lookup

To find "where are the rows for 2024-03-02 of `attendance_records`", the control plane needs an **index of covered days per job**. Manifests may overlap because of stragglers (§4.4). The control plane stores `(job_id, table, first_day, last_day, day_list_hash)`, and the full day list stays in the manifest.

---

## 10. Archive verification

The gate is fixed **[DOC §11] [P1]**:

```
ARCHIVE VERIFIED            → DELETION ALLOWED (after approval)
ARCHIVE VERIFICATION FAILED → DELETE 0 RECORDS
```

### 10.1 Checks

| # | Check | Detects | Full or sampled |
|---|---|---|---|
| V1 | Every expected object exists (HEAD); size matches the upload | Missing or partial upload | Full |
| V2 | Re-download each part; SHA-256 of bytes = SHA-256 recorded while uploading (plus provider checksum header where supported) | Corruption in transit or at rest | Full |
| V3 | Gunzip each part completely without error | Truncated or corrupt gzip | Full |
| V4 | Parse CSV: row count per part and per table = manifest counts | Lost or extra rows, serialization bugs | Full |
| V5 | PK column set in data = PK set in `keys/…`: equal cardinality, no duplicates, same sorted digest | Wrong rows, duplicates from retries | Full |
| V6 | Manifest self-consistency: per-table sums = job frozen counts; days covered = selection; schema hash present | Bookkeeping errors | Full |
| V7 | Source cross-check: for the frozen PKs, `count(*)` of rows still present with `md5(t::text) = row_hash` is reported (not required to equal, because drift is allowed) | Mass drift / schema change before deletion (fail early) | Full (cheap indexed query), or per batch |
| V8 | Restore test: load parts into a scratch Postgres and compare `md5(row::text)` with `keys/…` | Serialization infidelity (e.g. type round-trip bugs) | **Sampled** (see 10.2) |

### 10.2 Recommended practical model

- **The gate = V1–V6, all full, every job.** Cost is one re-download (~5–15 MB) and a streaming parse. Cheap. **Sampled verification is never the gate.**
- **V7** runs just before deletion approval and again per batch (the delete statement's hash guard *is* V7 per row).
- **V8** runs:
  - on 100 % of jobs for a table's first N archives (proposal: 3),
  - after any schema, Postgres or worker version change,
  - and on a periodic sample afterwards.

  A V8 failure blocks deletion for that table until investigated. It needs a scratch database; where that runs (a local container in the worker is sufficient) is a prototype question.
- **Per-record hashes** exist anyway (they are the deletion guard), so "row counts vs per-record hashes" is not a trade-off here. Both are used.
- Verification results are **stored immutably** with the job (the counts and hashes seen, verifier version, timestamps). Phase 1's `ArchiveVerification {expectedCount, verifiedCount, checksumMatch}` extends naturally (Appendix A).
- **Verification expiry:** if deletion has not started within N days of verification, re-run V1–V7 before deleting. Storage state may have changed. N is **UNDECIDED** (proposal: 7 days).

---

## 11. Safe deletion

### 11.1 Rules

1. **Never** a broad predicate. Every delete names exact PKs from the verified `keys/…` file, with the row-hash guard (§2.3 (7)):

   ```sql
   -- FORBIDDEN after verification (and at any other time):
   DELETE FROM t WHERE created_at < cutoff;
   ```

2. **Batches** (Phase 1 default 2,000 rows, configurable 100–50,000 **[P1]**). Start at ~1,000–2,000 on Nano and tune from prototype measurements.
3. **One short transaction per batch** with:
   - `SET LOCAL lock_timeout = '2s'`
   - `SET LOCAL statement_timeout = '30s'`

   These values are proposals.
4. **Grouped tables:** within one transaction, delete the batch's child rows (FK closure from the manifest), then the root rows, in reverse topological order (§5.2).
5. **Pacing:** sleep between batches (e.g. 100–500 ms), and back off when replication lag, lock waits or error rates rise, so production traffic and autovacuum keep up.
6. **Before every batch**, re-check in the control plane:
   - job state = `deleting`
   - lease owned by this worker
   - no global or per-app **kill switch**
   - FK graph hash unchanged (checked at start and periodically)
7. **Triggers:**
   - If `DELETE` triggers exist on a candidate table, deletion requires explicit operator acknowledgement. Some triggers would *insert* rows (audit), growing the database.
   - **Never** use `session_replication_role = replica` to suppress them. It also disables FK enforcement **[PG]**.

### 11.2 Recording, idempotency and resumability

- Per batch, persist in the control plane: `(job_id, table, batch_no, pk_first, pk_last, requested, deleted, drifted, missing, started_at, finished_at, attempt)`.
- Record the batch **after** the database commit returns (worker checkpoint), using the `RETURNING` PK list to compute `deleted`.
- **Re-running a batch is safe.** Already-deleted PKs affect 0 rows and are counted as `missing` on the retry. The reconciliation `requested = deleted + drifted + missing` still holds across attempts.
- **Resume** = continue from the first batch without a `finished_at`.
- **Partial failure** (timeout, lock timeout, connection loss):
  - The failed batch's transaction rolled back, so nothing from it is deleted.
  - Retry with exponential backoff up to N times, then move the job to `requires_review` (`deletion_halted` in Phase 1 terms, `JOB-00121` style).

### 11.3 Deletion verification

After the last batch:

- `SELECT count(*) FROM t WHERE pk = ANY(<frozen PKs>)` in chunks must equal the recorded `drifted` count. Rows still present must be exactly the drifted ones.
- `Σdeleted + Σdrifted + Σmissing = frozen count`, per table.
- Report, not error, the rows now present in the archived day range (stragglers or backdated inserts). They are expected.
- Then `ANALYZE` the tables. Plain `VACUUM` is optional; autovacuum normally handles it. **No `VACUUM FULL`** as part of a job (§7.4).
- Record database and table sizes before and after, with the §7.4 caveat that size may not drop.

---

## 12. Job state machine and recovery

### 12.1 Review of Phase 1 states

| Phase 1 status | Keep? | Notes |
|---|---|---|
| `preparing` | Keep | Policy snapshot, FK discovery, preflight checks. |
| `selecting` | Keep | Whole-day aggregate (read-only). |
| *(Candidate Frozen — pipeline step only)* | **Promote to a checkpoint inside `exporting`** | With §2.3 (7), freeze and export happen in the same snapshot, so "frozen" is a milestone the pipeline shows, not a separate waiting state. |
| `exporting` | Keep | Snapshot read → parts + keys → upload. |
| `verifying` | Keep | V1–V7 (and V8 if due). |
| `ready_for_deletion` | Keep | Verified. **Awaiting approval.** |
| `deleting` | Keep | Batched. |
| `completed` | Keep | Includes the deletion verification outcome. |
| `failed` | Keep, **narrow the meaning** | Terminal, **0 rows deleted** (failure before deletion started). |
| `requires_review` | Keep | Deletion started and halted, drift above threshold, or V8 failure. |

**Missing states:**

| New status | Why |
|---|---|
| `queued` (the document's "Created") | Job exists; not yet leased by a worker. |
| `deletion_approved` | Approval is a distinct, audited decision. Deletion may be scheduled for a maintenance window. |
| `verifying_deletion` | The document lists "Deletion verification" as a state **[DOC §15]**. Phase 1 has it only as a pipeline step. |
| `waiting_retry` | Transient failure (DB unavailable, storage down, credentials rejected) with a scheduled retry. It is not terminal and not a human task. |
| `cancelled` | Operator cancelled before deletion. Archive objects are retained or purged per policy. |
| `expired` | Verified but not approved within the validity window (§10.2). Must re-verify or cancel. |
| `completed_with_exceptions` *(or a flag on `completed`)* | Drifted rows were skipped. Data is safe, but the operator should know. |

### 12.2 Transitions (summary)

```
queued → preparing → selecting → exporting → verifying → ready_for_deletion
   → deletion_approved → deleting → verifying_deletion → completed[_with_exceptions]

any pre-deletion state ──(transient error)──▶ waiting_retry ──▶ (same state, resumed)
any pre-deletion state ──(permanent error / verification failed)──▶ failed            [0 deleted]
ready_for_deletion ──(timeout)──▶ expired ──▶ verifying | cancelled
deleting ──(batch retries exhausted, drift > limit, graph hash changed, kill switch)──▶ requires_review
requires_review ──(operator: resume | abandon)──▶ deleting | completed_with_exceptions
queued … ready_for_deletion ──(operator)──▶ cancelled
```

### 12.3 Mechanics

- **Lease:** `jobs.lease_owner`, `lease_expires_at`, and a worker heartbeat every ~30 s. A worker claims a job with `UPDATE … WHERE lease_expires_at < now()` or `SELECT … FOR UPDATE SKIP LOCKED` in the control-plane DB.
- **One active job per table/group:** a unique partial index on `(application_id, table_group)` for non-terminal statuses. This prevents duplicate or concurrent jobs on the same data (attack #8, #16).
- **Idempotency key:** `job_id + step + attempt`. Each step writes its result once. A resumed step first reads what exists.
- **Resume rules per step:**

| Step | Resume behaviour |
|---|---|
| preparing / selecting | Recompute (read-only). |
| exporting | **Restart the attempt from scratch** under a new `attempt-<n>` prefix. The old snapshot is gone, and a half-written archive must never be mixed with a new snapshot. Previous partial objects are deleted. |
| verifying | Re-run fully (idempotent). |
| deleting | Continue at the first unfinished batch (§11.2). |
| verifying_deletion | Re-run (idempotent). |

### 12.4 Failure and recovery matrix

| Failure | During | Detection | Automatic response | Rows deleted | Human action |
|---|---|---|---|---|---|
| Worker crash | selecting | Lease expiry | Another worker re-runs selection | 0 | None |
| Worker crash | exporting | Lease expiry | New attempt from scratch | 0 | None |
| Worker crash | verifying | Lease expiry | Re-run verification | 0 | None |
| Worker crash | deleting | Lease expiry | Resume at the next unfinished batch; re-run the in-flight batch (idempotent) | Committed batches only | None |
| Network failure to app DB | any | Connection error | `waiting_retry` with backoff; after N attempts → `failed` (pre-delete) / `requires_review` (deleting) | 0 / committed batches | Investigate if persistent |
| App DB unavailable, paused or read-only | any | Connection error / read-only error | As above. **Read-only: never auto-run the escape procedure.** Alert. | 0 / committed | Manual decision (§15) |
| Archive storage unavailable | exporting / verifying | Upload or GET errors | `waiting_retry`; attempt restarts | 0 | None, unless persistent |
| Archive storage unavailable | deleting | — | **Not needed.** Deletion reads the keys file, which should be cached locally after verification, or re-downloaded with a checksum check. If unavailable → `waiting_retry`. | committed | None |
| Verification failure | verifying | V1–V6 mismatch | → `failed`. Attempt objects retained for forensics. | **0** | Review, re-run a new job |
| Row drift above limit | deleting | Batch reconciliation | → `requires_review` | committed | Decide resume or abandon |
| FK graph or schema change | before / during delete | Graph/schema hash mismatch | Stop before the next batch → `requires_review` | committed | Re-plan |
| Lock or statement timeout | deleting | SQL error | Batch retried with backoff; then `requires_review` | committed | Tune batch size / timing |
| Credentials rejected or expired | any | Auth error | `waiting_retry` + alert | 0 / committed | Rotate secret |
| Duplicate job start | queued | Unique index violation | Second job rejected | 0 | None |
| Kill switch engaged | deleting | Checked before each batch | Pause → `requires_review` | committed | Release switch or cancel |

---

## 13. Database health and growth

### 13.1 "Average records added per day over the last six months" **[DOC §3]**

**Proposed exact definition (D-15):**

```
window   = the last 6 complete calendar months in the application time zone
           (the current, partial month is excluded; so the current partial day is excluded too)
added    = number of rows whose insertion timestamp falls inside the window
avg/day  = added ÷ number of days in the window
```

- This matches Phase 1's `averageDailyGrowth` (day-weighted over 6 complete months) **[P1]**. Only the source of `added` needs defining.
- **Source of `added`:** `created_at` when it is DB-defaulted (insertion time), **not** the business event date. Growth is about storage pressure, i.e. when rows arrived.
- **Tables without a trustworthy insertion timestamp:** use the snapshot method (13.2). Show "insufficient history" until 6 months of snapshots exist.
- **Deleted rows:** rows inserted in the window and later deleted (by the app, or by archival for short protected periods) are **not** counted by a `created_at` query. That under-reports insert volume. Acceptable, but the UI should say "rows inserted in the window that still exist" until snapshots are available.
- **Imports/backfills:** a bulk import appears as a spike on its `created_at` day.
  - Detect days above k × the median daily count (proposal k = 5).
  - Show the average both **with** and **without** flagged spike days.
  - Never silently drop them.
- **Missing dates:** rows with NULL `created_at` are excluded from growth and counted separately.
- **Levels:** table-level growth is primary. Application-level growth = Σ table growth **[P1]**, plus database-size growth in MB/day from daily size snapshots (13.3). The two answer different questions (§15).

### 13.2 Snapshot method (complementary)

The control plane stores one **daily** snapshot per table:

- estimated rows
- exact rows (when measured)
- total bytes
- dead tuples

It also stores daily database-size snapshots. After 6 months, `net growth/day = (rows_today − rows_180d_ago + rows_archived_in_between) / days`. This captures deletions, and in MB it gives capacity runway directly.

### 13.3 Estimated days to next threshold (projection)

```
days = ceil( (next_threshold − current_rows) / avg_daily_growth )
```

- Undefined when growth ≤ 0 **[P1 `projectDaysToThreshold`]**.
- Always labelled as an **estimate at the 6-month average rate, not a guarantee** **[P1]**.
- Optionally show a range using the lowest and highest monthly rate in the window.
- The same form applies to capacity: `days_to_capacity = (capacity_MB × level − size_MB) / MB_growth_per_day`.

### 13.4 Counting cost

- **Exact `count(*)`** on a 1M-row table is a full index or heap scan, fine daily but wasteful every few minutes.
- **Recommended cadence:**
  - Catalog **estimates** (`reltuples`, `n_live_tup`) on every health check (e.g. every 15–60 min).
  - An **exact** count once daily, and whenever an estimate is within ±5 % of a threshold, so a LOW/MEDIUM/HIGH boundary is never decided on an estimate.
- The UI marks each count "estimated" or "exact" (Appendix A).

---

## 14. Thresholds

- **Kept exactly as defined** **[DOC §3] [P1]**: 10 lakh → LOW, 11 lakh → MEDIUM, 12 lakh → HIGH. Inclusive comparisons (`>=`).
- **Scope (D-16, recommended):**
  - Global defaults (as now).
  - An **optional per-table override**, for tables where 10 lakh rows is trivially small (narrow rows) or already critical (wide rows).
  - Per-application overrides are **not** recommended initially. They add a precedence layer without a demonstrated need. **Business confirmation needed** only if per-table override is wanted.
- **Overrides must:**
  - keep the LOW < MEDIUM < HIGH ordering (Phase 1 validation),
  - be audit-logged,
  - be displayed next to the value ("custom threshold").
- **Capacity thresholds are independent** of record thresholds (§15), stored separately **[P1]**. Their values (Phase 1 demo 70/80/90 %) are **UNDECIDED business values**.
- **Alert semantics** from the document **[DOC §3]**: escalation, recovery, duplicate suppression. Phase 1 models all three. Suppression window (24 h in the mock) is a business value.
- Thresholds **never trigger archival by themselves** **[P1 copy] [DOC §4]**: "Retention determines eligibility; infrastructure thresholds determine when attention is needed."

---

## 15. Database capacity vs record count

### 15.1 Two separate health signals

| | Record-count health | Storage health |
|---|---|---|
| Measures | Rows per table | Bytes per database (500 MB Free limit) |
| Thresholds | 10 L / 11 L / 12 L | % of plan capacity (values UNDECIDED) |
| Failure mode | Performance or management pressure | **Read-only database: writes and deletes blocked** |
| Hard limit? | No | **Yes** |

### 15.2 How storage can go critical before any table reaches 12 lakh

- **Wide rows:** JSON payloads, base64 blobs, long text. 300k rows can outweigh 1.2M narrow rows.
- **Many medium tables:** 15 tables at 5 lakh each, none alerting.
- **Indexes:** can equal or exceed heap size.
- **Dead tuples/bloat** after heavy UPDATE/DELETE churn, including after archive jobs themselves (§7.4).
- **Non-application schemas:**
  - `cron.job_run_details` (grows with every cron run)
  - `net._http_response` (pg_net)
  - `auth.audit_log_entries`
  - `storage.objects` metadata
  - `supabase_migrations`

  These are **invisible** if monitoring only looks at `public`. **[INFERENCE]**

### 15.3 What should happen

1. The capacity alert follows the same LOW/MEDIUM/HIGH ladder, with its own values.
2. The dashboard shows the **top relations by total bytes across all schemas**, with dead-tuple % and last autovacuum, so the operator can see *what* consumes space (Phase 1's Database Health page has a slot for this).
3. Operator options, in order of safety:
   1. Prune platform logs (cron and net history) per Supabase guidance.
   2. `VACUUM`, and `ANALYZE` to refresh stats.
   3. Run archive jobs on the largest *eligible* tables, even if below record thresholds. **This is still governed by policy**; capacity never makes a Review Required table archivable.
   4. `pg_repack` for bloated tables if disk allows (§7.1).
   5. Upgrade the plan.
4. **Capacity pressure may justify an under-target archive** (§3.10, option D). This is a business decision.
5. At **HIGH** capacity, the system should recommend starting remediation immediately. The read-only cliff blocks remediation itself.

---

## 16. Security

### 16.1 Trust boundaries

```
Browser ──HTTPS──▶ Control plane (Next.js server + central DB) ──job specs──▶ Worker ──▶ App DBs (N)
                                                                              └──────▶ Archive storage
```

- **The browser never receives any database credential, service-role key, secret key, storage key or presigned write URL.** **[DOC §17] [P1 intent]** It receives only rendered data, and short-lived presigned **read** URLs after authorization (16.5).
- Next.js Route Handlers / Server Actions (App Router) run server-side. Credentials live only there and in the worker.

### 16.2 Per-application database credentials

- **Do not use the `service_role` / `sb_secret_…` key** for the worker. It bypasses RLS and grants API-wide power **[FACT]**. Use **Postgres login roles**, which Supabase supports and recommends per service **[FACT]**.
- Proposed roles in each application DB (created by the application owner, **not** by this system):

| Role | Privileges |
|---|---|
| `uniqbotz_monitor` | `CONNECT`; `SELECT` on catalog/statistics views (`pg_stat_user_tables`, sizes). **No table data.** |
| `uniqbotz_archiver` | `SELECT` on archivable tables; **`DELETE` only on tables whose policy is Archive + Enabled**; no `UPDATE/INSERT/TRUNCATE/DDL`; role-level `statement_timeout` / `lock_timeout`; connection limit (e.g. 2). |

- **RLS:** a normal role sees **zero rows** on RLS-enabled tables without policies. Options:
  - (a) grant `BYPASSRLS`, if Supabase permits it for custom roles,
  - (b) add RLS policies scoped to `uniqbotz_archiver`.

  **Requires prototype** (P-6). Getting this wrong fails *safe* (0 rows exported → V4 fails), but must be understood.
- Granting `DELETE` per table at enable time is least privilege, but needs an application-owner action on each policy change. The alternative, a broad `DELETE` on `public` with enforcement in the worker, is weaker. **Recommendation: per-table grants.** Owner-coordination cost is accepted.

### 16.3 Secret storage and rotation

- **Options:**
  - (a) the worker platform's secret manager / environment secrets,
  - (b) Supabase Vault in the control-plane DB **[FACT]**, read by the worker's DB role,
  - (c) a cloud KMS/secret manager.
- **Recommendation:** (a) or (c) for the worker. The control-plane DB stores only **secret references**, never secret values. This keeps a control-plane DB compromise from yielding every app credential. (b) is acceptable if the worker's DB role is the only reader.
- **Rotation:** per app, with dual-credential rollover (create new password → update secret → verify → drop old). Target cadence is **UNDECIDED**. Also rotate on staff change and on suspicion.
- Credential expiry or rejection → `waiting_retry` + alert (§12.4). Never loop login attempts.

### 16.4 Control-plane authentication and authorization

- Production authentication is required before any live data is shown. Options: Supabase Auth on the control-plane project with MFA, or an SSO provider. **UNDECIDED** (no requirement in documents beyond "administrator authentication" **[DOC §17]**).
- **Roles (proposal):**

| Role | Can |
|---|---|
| Viewer | See health, alerts, jobs |
| Operator | Edit policies, create and cancel jobs |
| **Approver** | Approve deletion |
| Admin | Settings, application registry, credentials references, kill switch |

- **Deletion approval:** the Phase 1 flow (verified → review → type the job ID → confirm) stays. Additional controls are **UNDECIDED business rules**:
  - approver ≠ job creator (two-person rule),
  - approval validity window,
  - allowed deletion windows (e.g. night IST).
- **Kill switch:** global and per application. Checked before every batch (§11.1).

### 16.5 Archive access

- Private buckets only; public access blocked.
- The worker's storage credential is scoped to the archive bucket/prefix.
  - It needs PUT, GET and LIST for export and verification.
  - DELETE only for its own failed-attempt prefixes, if the provider's policy language allows prefix scoping.
- **Downloads for restore/inspection:**
  - authorized in the control plane (Approver or Admin),
  - audited,
  - served as **short-lived presigned GET URLs** (minutes).
- **Encryption:** provider default at rest (§8), plus TLS in transit. **Client-side envelope encryption** (a per-archive data key encrypted by a KMS key) adds protection against provider-side access, at the cost of key management. **UNDECIDED**; it depends on data classification (§17).

### 16.6 Audit logging

- Every policy change, job transition, approval, verification result, batch result, download authorization, credential rotation and kill-switch action is written to an **append-only** audit table in the control plane. The app role has INSERT only; no UPDATE or DELETE.
- Optional hash-chaining (each entry includes the previous entry's hash) for tamper evidence.
- A periodic export of the audit log to archive storage.
- Phase 1's `AuditEntry` shape already covers actor, action, table, result and job reference **[P1]**.
- Audit retention: see §17 (log-retention obligations).

---

## 17. Data privacy and personal data

> **Not legal advice.** Facts below are from official summaries and secondary sources (Appendix B); several could only be read as search excerpts. **All legal applicability questions are listed for confirmation by counsel.**

### 17.1 Regulatory context (facts, with confidence)

- **DPDP Act 2023 / DPDP Rules 2025:**
  - The Rules were notified in **November 2025** with **phased commencement**.
  - The substantive obligations (notice, consent, security safeguards, retention/erasure, breach notification, data-principal rights, cross-border rules) are reported to take effect **~18 months later (around May 2027)**. **[FACT for notification; timeline from secondary sources]**
  - A proposal to shorten timelines for Significant Data Fiduciaries was reported in January 2026. **Not confirmed as notified.**
- Reported obligations relevant to this system **[secondary sources]**:
  - **Storage limitation:** erase personal data when the purpose is served or consent is withdrawn, unless law requires retention.
  - **Minimum retention (Rule 8(3), as reported):** personal data and associated traffic data and **logs of processing kept at least 1 year**, then erased unless another law requires longer.
  - **Reasonable security safeguards (Rule 6, as reported):** encryption/masking/tokenization, access controls, logging and monitoring (logs kept ≥ 1 year), backups/continuity, processor contracts.
  - **Breach notification:** to the Data Protection Board and affected persons; a detailed report within 72 h (reported).
  - **Cross-border transfer:** negative-list approach. No restricted list reported as notified. Sectoral rules (e.g. RBI payment-data localisation) may still apply.
- **CERT-In Directions (28 Apr 2022):** logs of ICT systems kept for a **rolling 180 days within Indian jurisdiction**; incidents reported **within 6 hours**. **[FACT]**

### 17.2 Tensions this system must accommodate

1. **Archive is still personal data.** Moving rows to object storage does not end the obligations; it relocates them. Archives need their own retention period and deletion process.
2. **Erasure requests vs immutable archives.** An erasure request for a person whose rows are archived requires finding and removing them *inside* archive files:
   - a searchable index (which archives contain subject X), and
   - an archive **rewrite** capability (produce a new verified object without those rows, delete the old one).

   WORM/Object Lock in compliance mode would make this impossible.
3. **Minimum vs maximum retention.** A reported 1-year minimum for data/logs vs purpose-based erasure. Protected periods (6–24 months in Phase 1 policies) must be set with this in mind.
4. **Log location.** CERT-In requires logs within India. Audit logs and worker logs hosted outside India may conflict.

### 17.3 Technical controls to build in (independent of the legal answers)

| Control | Where |
|---|---|
| **Data classification per table** (e.g. contains personal data: yes/no/unknown; categories; purpose) | New policy fields (Appendix A). Default "unknown" → treated as personal. |
| **Retention purpose** per table | Policy field, shown in audit. |
| Access control | §16.4 roles; archive downloads need Approver/Admin + audit. |
| Encryption | In transit (TLS); at rest (provider); optional client-side (§16.5). |
| **Archive lifecycle** | Per-table archive retention (e.g. delete archive N years after boundary). Enforced by a job, *or* bucket lifecycle rules where the provider supports them. |
| **Permanent deletion from archive** | Rewrite-and-verify job type; log the rewrite; delete the old object and all versions. |
| **Subject index** (optional) | Per archive, a list of data-subject identifiers (hashed) to answer "which archives contain X". Only needed if erasure requests must reach archives. |
| Deletion records | Every source deletion and archive purge in the audit log (counts, job, approver), **not** the deleted content. |
| Restoration controls | Restore is a privileged, audited operation into a scratch environment by default. Never automatic back into production. |
| Masking/redaction | For human-facing exports (XLSX), mask direct identifiers unless the requester's role allows. |
| Breach readiness | Access logs on buckets; alerting on unusual downloads. |

### 17.4 Questions requiring legal/business confirmation

- **Q-L1** Must archives (and logs) of Indian users' personal data be stored **in India**? This decides the storage provider (§8).
- **Q-L2** Are any applications (or UniqBotz) likely to be **Significant Data Fiduciaries**, or in the classes with prescribed retention caps (e.g. large e-commerce)? Almost certainly not at current scale, but confirm.
- **Q-L3** What is the **retention period for archives** per data category (attendance, payments, orders, audit logs)? Are there tax/accounting requirements for payments and orders (e.g. multi-year retention)?
- **Q-L4** Must **erasure requests** be applied inside archives, and within what time?
- **Q-L5** How long must **audit and processing logs** be kept, and where (1 year per reported Rule; 180 days in India per CERT-In)?
- **Q-L6** Who at UniqBotz is the accountable owner (grievance/DPO-equivalent) for these archives?
- **Q-L7** Is client-side encryption required for archives containing personal data?

---

## 18. Cost and complexity (qualitative)

### 18.1 Volume estimate

From Phase 1 mock growth. **[ASSUMPTION]**; replace with real measurements.

| | Archivable growth | Jobs/yr at 125k | Compressed archive/yr | Supabase read egress/yr |
|---|---|---|---|---|
| RosiFit | ~2.5k rows/day | ~7 | ~0.1 GB | < 0.3 GB |
| UniqBrio | ~1.8k rows/day | ~5 | ~0.07 GB | < 0.2 GB |
| Jalsa | ~10.5k rows/day | ~31 | ~0.4 GB | < 1.2 GB |
| **3 apps** | ~15k rows/day | **~43** | **~0.6 GB** | **~1.7 GB** (vs 60 GB/yr quota per org) |
| **10 apps** (extrapolated) | ~50k/day | ~150 | ~2 GB | ~6 GB |
| **50 apps** (extrapolated) | ~250k/day | ~730 (≈ 2/day) | ~10 GB | ~30 GB (spread over orgs) |

### 18.2 Cost drivers

| Driver | 3 apps | 10 apps | 50 apps |
|---|---|---|---|
| Worker compute | One small unit, mostly idle (jobs take minutes). Near-zero to a few $/month. | Same unit | Same unit or two. ~2 jobs/day plus health checks. |
| Archive storage | Cents/month (fits free tiers of R2/B2) | < $1/month | A few $/month |
| Egress | Negligible | Negligible | Depends on provider (verification re-downloads). Negligible on zero-egress providers. |
| Control-plane DB | Free-tier size (metadata only) | Free-tier size, if manifests are kept out of it (D-02) | Snapshot tables need pruning. May need a paid plan. |
| **Supabase projects** | **3 apps + 1 control plane > 2 free projects per owner** (§7.2) | Paid plans likely | Paid plans certain |
| Monitoring/logging | Worker logs + control-plane audit | Same | Log volume and retention rules matter (§17) |
| **Operational maintenance** | Role provisioning + secret per app; approvals ~1/week | Approvals ~3/week | **Approvals ~2/day → approval fatigue** (attack #20) |

### 18.3 Conclusion

- **Money is not the constraint; human operations and Supabase plan limits are.** **[INFERENCE]**
- The architecture should minimize **deployables** (one worker, one control plane) and **per-app manual steps** (role creation, secret registration).
- At 50 apps, **per-job manual deletion approval** will not scale safely. A policy for **pre-approved automatic deletion** of routine jobs, e.g. after N clean runs on a table with no drift and V8 passing, is a future business decision. It is **not** proposed for Phase 3.

---

## 19. Central vs sidecar vs hybrid

| Area | Central worker | Sidecar worker (per app) | Hybrid (central control plane + central worker; sidecar optional) |
|---|---|---|---|
| Deployment | 1 service | N services | 1 control plane + 1 worker (N only where isolation needed) |
| Isolation | Low: one process holds all app credentials | **High**: one app per process | Medium by default; high for apps given a sidecar |
| Failure blast radius | A bug or compromise affects all apps | One app | All apps by default, but the control plane can halt the worker globally (kill switch); sidecars isolate chosen apps |
| Cost | Lowest | Highest (N units) | Low (≈ central) |
| Complexity | Low | High (N deploys, N monitors, version drift) | Low to medium (clear API between control plane and worker) |
| Scaling | Vertical, then multiple workers on a lease queue | Natural per app | Lease queue: add workers without code changes |
| Security | Credentials concentrated. Needs strong secret handling. | Best | Control plane holds **no** app secrets; worker does. Can move secrets into sidecars later. |
| Supabase compatibility | Good (pooler, session mode, no in-DB install) | Good | Good |
| Maintenance | One codebase, one deploy | N deploys of one codebase | One codebase; worker "single-app mode" for sidecars |
| Future apps | Registry row + role + secret | New deployment each | Registry row + role + secret; optional sidecar |

**Reading:**

- Hybrid does **not** win because it is more sophisticated. It is essentially the central worker **plus** a clean separation between *deciding* (control plane) and *doing* (worker).
- Phase 1 already implies that separation (`InfrastructureDataSource` for the UI, jobs as records).
- The separation costs little and keeps the sidecar option open without re-architecture.

---

## 20. Architecture attack

A hostile review of the recommended design (§22). For each scenario: **F** = failure, **D** = detection, **P** = prevention, **R** = recovery.

1. **Database fills before the archive completes.**
   - **F:** The DB crosses 500 MB mid-job → read-only → export still works (reads), but **deletion fails**. **[FACT]**
   - **D:** Capacity alerts; the read-only error on the first batch.
   - **P:** Capacity alerts at MEDIUM/HIGH well below 500 MB (§15). Size projection in MB/day. Archive jobs start at LOW/MEDIUM, not HIGH. No manifest or other writes in the source DB (D-02). Prune cron/net logs.
   - **R:** Job → `waiting_retry`/`requires_review`. Operator performs Supabase's documented manual escape (session read-write → delete → vacuum → restore) as a **manual, audited emergency procedure**, or upgrades the plan. Never automated.

2. **Worker crashes halfway through export.**
   - **F:** Partial parts uploaded; snapshot lost.
   - **D:** Lease expiry.
   - **P:** Attempt-scoped prefixes; the manifest is written last.
   - **R:** New attempt from scratch. Orphan parts deleted. 0 rows deleted.

3. **Upload succeeds but verification fails.**
   - **F:** Corrupt or incomplete archive.
   - **D:** V1–V6.
   - **P:** Streaming checksums at write time; provider checksum headers.
   - **R:** `failed`, **0 deleted** (Phase 1 `JOB-00125` path). Objects kept for forensics. A new job re-exports.

4. **Verification succeeds but deletion fails halfway.**
   - **F:** Some batches committed.
   - **D:** Batch errors.
   - **P:** Short per-batch transactions; per-batch checkpoints.
   - **R:** Resume at the first unfinished batch. Rows already deleted are in the verified archive (I-1 holds). `requires_review` if retries are exhausted (Phase 1 `JOB-00121` path).

5. **Network disconnects during deletion.**
   - **F:** Ambiguous: did the in-flight batch commit?
   - **D:** Connection error.
   - **P:** Batches are idempotent (PK + hash).
   - **R:** Re-run the batch. Reconciliation counts the already-deleted PKs as `missing`. The totals still close.

6. **A new record arrives after candidate selection.**
   - **F:** None.
   - **P:** Not in the frozen manifest, so never addressed by any delete (D-01).
   - **R:** N/A.

7. **A backdated record arrives after candidate selection.**
   - **F:** Not archived by this job.
   - **D:** Deletion verification reports rows present in the archived day range.
   - **P:** Exact-PK deletion (never deleted). Next selection starts at `MIN(date)` (D-05).
   - **R:** Picked up as a straggler by the next job.

8. **Two archive jobs run simultaneously on the same table.**
   - **F:** Overlapping manifests.
   - **D:** Unique partial index on active jobs per table group.
   - **P:** The second job is rejected at creation.
   - **R:** N/A.
   - **Even if bypassed:** two manifests containing the same PK both archive it. The second delete finds it `missing`. No data loss, only duplication in the archive.

9. **Two applications archive simultaneously.**
   - **F:** Worker contention; each app's Nano DB is independent, so no DB contention.
   - **D:** Worker metrics.
   - **P:** A worker concurrency limit (e.g. 1–2 concurrent jobs); pacing per app DB.
   - **R:** Jobs queue. Egress is per org, so watch org-level totals.

10. **FK dependency incorrectly configured** (e.g. an undeclared logical relationship, or a new CASCADE added by an app migration).
    - **F:** Silent child deletion, or orphans.
    - **D:** FK graph discovered from the catalog at job start and re-checked before deletion (graph hash).
    - **P:** CASCADE / SET NULL edges to non-group tables block the job (§5.2). Operator-declared logical relationships (if adopted).
    - **R:** Job halted before the first batch. Undeclared logical relationships **cannot be detected**; residual risk accepted and documented.

11. **Table schema changes while the archive is running.**
    - **F:** Export and delete disagree.
    - **D:** Schema hash at export vs before deletion; row hashes all mismatch.
    - **P:** Fail-closed hash guard.
    - **R:** 0 rows deleted → `requires_review` → cancel. A new job exports with the new schema.

12. **Database becomes unavailable (or paused).**
    - **F:** Any step fails.
    - **D:** Connection errors.
    - **P:** No in-DB state required to resume.
    - **R:** `waiting_retry` with backoff, then alert.

13. **Archive storage becomes unavailable.**
    - **F:** Export or verify fails.
    - **D:** HTTP errors.
    - **P:** Deletion never *starts* without verification. During deletion, keys are cached with checksum.
    - **R:** `waiting_retry`. 0 deleted if before deletion.

14. **Credentials expire or are revoked.**
    - **F:** Auth errors.
    - **D:** Explicit auth-error classification.
    - **P:** Rotation runbook; expiry monitoring where the credential has an expiry.
    - **R:** `waiting_retry` + alert. Resume after rotation.

15. **Archive object corrupted** (bit rot, tampering, accidental overwrite).
    - **F:** Restore impossible, *after* the source rows are gone.
    - **D:** Periodic re-verification of stored archives (V1–V5 on a schedule), provider checksums.
    - **P:** Provider durability; versioning or object lock where compatible with erasure duties (§17); an optional second copy.
    - **R:** **If the source rows are already deleted, the loss is permanent.** Free Plan has no backups **[FACT]**. This is the strongest argument for the UNDECIDED pre-deletion safety dump and a second archive copy.

16. **A duplicate retry starts the same job.**
    - **F:** Two workers on one job.
    - **D:** Lease ownership check on every write.
    - **P:** Lease + heartbeat; the losing worker aborts on lease mismatch.
    - **R:** Idempotent steps. Deletes are safe even if both ran (scenario 5 logic).

17. **Target is not reached.**
    - **F:** No job, or an unexpected small job.
    - **D:** Candidate preview state (Phase 1 already shows it).
    - **P / R:** Business decision (§3.10). Until decided, no job is created.

18. **Database remains large after DELETE** (dead tuples).
    - **F:** The operator believes archival failed; size alerts persist.
    - **D:** Dead-tuple stats; before/after size.
    - **P:** UI states that space is reused rather than returned (§7.4). Capacity projections based on growth after the job.
    - **R:** Autovacuum/VACUUM; `pg_repack` if disk allows; plan upgrade. **No automated VACUUM FULL.**

19. **Archive storage itself becomes the new retention problem.**
    - **F:** Unbounded growth of personal data in archives.
    - **D:** Archive inventory per table and age.
    - **P:** Per-table archive retention + purge job/lifecycle (§17.3). Classification.
    - **R:** Purge by policy, audited.

20. **Operator approves the wrong deletion.**
    - **F:** A wrong table, a wrong app, or a correct job on a table whose data the business still needs.
    - **D:** None after the fact, except audit.
    - **P:**
      - The review screen shows app, table, count, boundary and verification.
      - The typed job ID (Phase 1).
      - Approver ≠ creator (proposed).
      - Deletion windows.
      - Approval expiry.
      - Kill switch.
      - The Archive policy itself had to be set deliberately, and "Review Required" can never be approved.
    - **R:** Deleted rows exist in the verified archive. **Restore** into production is possible but manual, and must be designed (restore tooling is out of scope for Phase 3 but is a known gap).

**Additional scenarios found during review:**

21. **Audit trigger on a candidate table.**
    - **F:** Deleting 125k rows inserts 125k audit rows → the DB grows during cleanup.
    - **P:** Trigger discovery + acknowledgement (§11.1).
    - **R:** Pause, adjust.

22. **Long export snapshot blocks vacuum.**
    - **F:** Bloat on busy tables during export.
    - **D:** Export duration metrics.
    - **P:** Keep exports short (P-1); schedule off-peak.

23. **Time-zone mismatch between selection and export.**
    - **F:** Day boundaries differ, so counts differ.
    - **P:** One time zone pinned in the job spec and the manifest. Sargable boundaries computed once.

24. **Control-plane project paused or read-only.**
    - **F:** No leases or checkpoints can be recorded.
    - **P:** The worker keeps the control plane active; monitor its size too.
    - **R:** The worker stops before the next batch when it cannot checkpoint. **Never delete without a recordable checkpoint.**

---

## 21. Decision matrix

### 21.1 Decisions that can be finalized now

| ID | Decision | Basis |
|---|---|---|
| D-01 | Deletion addresses **exact PKs from the verified manifest, guarded by an unchanged-row hash**. Never a date range, watermark or boundary. | [DOC §6, §12], §2 |
| D-02 | Manifests and per-row job data live **outside** source databases (object storage). The control plane stores metadata only. | §2.3 (2), §7 |
| D-03 | Freeze = one short `REPEATABLE READ READ ONLY` export snapshot across the job's tables. No snapshot is held across verification or deletion. | §2.3 (5, 7) |
| D-04 | Archivable tables must have a PK (or unique NOT NULL key). `ctid` is never an identity. | §2.3, A-1 |
| D-05 | Persist the boundary for audit, but start each selection at the actual oldest eligible date. | §3.9, §4.4 |
| D-06 | Date column is configurable per table, must be `date`/`timestamp`/`timestamptz`, and is never `updated_at`. NULL dates are never eligible. | §3.5, §3.7, §4.3 |
| D-07 | Grace period: keep the global default and add an optional per-table override. **Values** come from evidence (§4.5). | [DOC §7], §4 |
| D-08 | The FK graph is discovered from the catalog at policy save and job start. CASCADE/SET NULL/SET DEFAULT edges to tables outside the group block the job. Deletion order is derived (reverse topological), never hard-coded. FK groups are root-driven. | [DOC §8], §5 |
| D-09 | Nothing is installed in application databases except least-privilege **login roles** created by app owners. The worker never uses `service_role`/secret API keys. | §6, §16 |
| D-10 | **Hybrid:** central control plane + stateless worker. Edge Functions are not used for export/delete. pg_cron is at most a scheduler in the control-plane project. | §6, §19 |
| D-11 | The worker connects via **Supavisor session mode** (IPv4, session settings, snapshot transactions). | §7.2 |
| D-12 | Archive = CSV.GZ via Postgres `COPY`, in parts, + `manifest.json` + `schema.json` + `keys/`. XLSX is never the archive of record. *(Confirm round-trip in P-3.)* | [DOC §9], §9 |
| D-13 | The verification gate = V1–V6 in full, every job. Sampling is never the gate. V8 (restore test) runs on the first archives per table and after changes. | [DOC §11], §10 |
| D-14 | Deletion runs in short, paced, idempotent batches with per-batch checkpoints, lock and statement timeouts, a kill-switch check, trigger acknowledgement and no `session_replication_role`. No `VACUUM FULL` inside jobs. | [DOC §12], §11 |
| D-15 | Growth = rows inserted in the last 6 complete months ÷ days (app time zone), with spike flagging and snapshot-based net growth once history exists. | [DOC §3], §13 |
| D-16 | 10 L / 11 L / 12 L thresholds unchanged, as global defaults. Capacity thresholds are separate. | [DOC §3], §14 |
| D-17 | Record-count health and storage health are separate signals with separate alerts. Storage monitoring covers all schemas. | §15 |
| D-18 | State machine extended with `queued`, `deletion_approved`, `verifying_deletion`, `waiting_retry`, `cancelled`, `expired`, plus a completed-with-exceptions outcome. `failed` means 0 deleted. | [DOC §15], §12 |
| D-19 | At most one active job per (application, table group), enforced by a DB constraint and worker leases. | §12.3 |
| D-20 | The browser never receives credentials. The control plane stores secret *references* only. The audit log is append-only. | [DOC §17], §16 |
| D-21 | Health checks use catalog estimates frequently and exact counts daily and near thresholds, labelled as such. | §13.4 |

### 21.2 Decisions that require user/business input

| ID | Question | Why it matters | Default until answered |
|---|---|---|---|
| Q-B1 | **Supabase plans and ownership:** RosiFit, UniqBrio, Jalsa and a control-plane project exceed **2 active free projects per owner**. Which are paid, or how is ownership split? Also: egress quotas are per organization. | Hard platform limit | Blocks the live rollout |
| Q-B2 | Behaviour when the **target is not reached** (§3.10) | Job creation logic | Report only, no job |
| Q-B3 | Behaviour for a **single oversized day** (§3.11) | Job size | Allow (rule as written) |
| Q-B4 | **Business time zone** per application | Day boundaries | `Asia/Kolkata` proposed, unconfirmed |
| Q-B5 | **Capacity threshold** values | Alerts | Phase 1 demo 70/80/90 % |
| Q-B6 | Late-data processes per app (imports, offline sync, corrections) → grace values per table | Fragmentation | 7 days global |
| Q-B7 | **Deletion approval rules:** two-person rule, validity window, allowed windows, who holds the Approver role | Safety | Single typed confirmation (Phase 1) |
| Q-B8 | May unrelated tables share one job? Support operator-declared logical relationships? | Job model | Separate jobs per FK group |
| Q-B9 | Is a **pre-deletion safety dump** (or a second archive copy) required, given Free has no backups? | Irreversibility | Strongly recommended; not decided |
| Q-B10 | **Archive retention periods** per data category and purge process | Privacy, storage growth | Keep; no purge |
| Q-B11 | Worker hosting environment and budget; India hosting preference | Ops, residency | — |
| Q-B12 | Production authentication method and role holders | Access | — |
| Q-B13 | Per-table threshold overrides wanted? | Config scope | Global only |
| Q-L1…Q-L7 | Legal questions in §17.4, especially **Q-L1 data location** (decides the storage provider) | Compliance | — |

### 21.3 Decisions that require a technical prototype

All prototypes run against a **disposable Supabase project with synthetic data** (subject to Q-B1), never against RosiFit, UniqBrio or Jalsa.

| ID | Prototype | Answers |
|---|---|---|
| P-1 | Export 125k/250k/500k rows in one `REPEATABLE READ` snapshot through Supavisor session mode on Nano | Duration, timeouts (A-3), vacuum impact, egress per job |
| P-2 | `md5(t::text)` / `sha256` stability and cost across types and pinned session settings | A-2, A-4 |
| P-3 | CSV `COPY` round-trip (export → restore → row-hash equality) for all column types in the apps | D-12, V8 |
| P-4 | Batched PK+hash deletion: batch size vs latency, lock waits, WAL, autovacuum, `pg_database_size` before and after | D-14, §7.4 claims on Supabase |
| P-5 | Read-only FK/trigger/PK/date-column discovery on the real schemas (catalog-only, `uniqbotz_monitor` role) | §5 group design per app |
| P-6 | Custom login roles on Supabase: pooler login, per-table `DELETE` grants, role-level timeouts, **RLS behaviour (BYPASSRLS or policies)** | §16.2 |
| P-7 | Storage provider integration: multipart upload, checksum headers, re-download verification, presigned GET, lifecycle/versioning | §8, §10 |
| P-8 | Read-only-mode behaviour and the documented escape procedure in a disposable project | Scenario 1 runbook |
| P-9 | Estimate vs exact count accuracy and cost; health-check egress | §13.4 |
| P-10 | Lease/queue semantics under crash injection (kill the worker mid-export and mid-delete) | §12 |

---

## 22. Recommended Phase 2 architecture

### 22.1 Proposal

**A hybrid control plane + single stateless worker, with exact-PK manifests and hash-guarded batched deletion.**

```
                          ┌───────────────────────────────────────────┐
  Operator (browser) ───▶ │ Control plane                             │
                          │  • Next.js app (Phase 1 UI) — server-side │
                          │    InfrastructureDataSource implementation│
                          │  • Central Postgres (Supabase project):   │
                          │    registry, policies, snapshots, jobs,   │
                          │    job_steps, job_batches, approvals,     │
                          │    audit (append-only)                    │
                          │  • Scheduler (pg_cron or worker timer)    │
                          └───────────────┬───────────────────────────┘
                                          │ job specs / checkpoints (lease)
                          ┌───────────────▼───────────────────────────┐
                          │ Worker (one deployable; single-app mode   │
                          │ available for future sidecars)            │
                          │  health checks · selection · snapshot     │
                          │  export · gzip · SHA-256 · upload ·       │
                          │  verify V1–V8 · batched delete · reconcile│
                          └──────┬──────────────────────────┬─────────┘
             Supavisor session   │                          │  S3 API (private bucket)
             mode, per-app roles │                          │
          ┌──────────────────────▼──────┐        ┌──────────▼───────────────┐
          │ RosiFit / UniqBrio / Jalsa  │        │ Archive storage          │
          │ / future Supabase projects  │        │ (provider per Q-L1)      │
          │ (untouched except 2 roles)  │        │ manifest · schema · data │
          └─────────────────────────────┘        │ · keys                   │
                                                 └──────────────────────────┘
```

### 22.2 End-to-end flow

Mapped to the architecture document **[DOC §18]**:

1. **Monitor:** the worker collects catalog stats per app → snapshots.
2. **Detect / Alert:** the control plane evaluates thresholds → alerts. WhatsApp and email come in a later phase.
3. **Evaluate policy:** only Archive + Enabled tables with a PK, a typed date column and a valid FK group.
4. **Select:** whole-day aggregation from `MIN(date)`, per §3.
5. **Freeze + export:** one snapshot → parts + keys + manifest + schema.
6. **Verify:** V1–V6 (+ V8 when due) → `ready_for_deletion`.
7. **Approve:** an audited human decision → `deletion_approved`.
8. **Delete:** exact PK + hash batches, paced, checkpointed.
9. **Verify deletion:** reconcile → `completed` (or with exceptions).
10. **Recheck health and audit** → notify (later phase).

### 22.3 Why

- It meets every hard requirement in the architecture document (conservative defaults, mandatory verification, exact-candidate deletion, resumability, auditability) with the **fewest deployables**: one control plane (which already exists as the Phase 1 app) and one worker.
- It avoids every Supabase Free Plan limit found:
  - no Edge Function time limits,
  - no writes to near-full source DBs,
  - IPv4 via Supavisor,
  - tiny egress.
- It keeps the product interface: Phase 1's `InfrastructureDataSource` becomes the server-side read/write API. The job, pipeline and verification shapes extend rather than change (Appendix A).
- It leaves the sidecar isolation path open without re-architecture.

### 22.4 Assumptions

- A-1…A-4 (§2.3).
- Application owners can create two login roles in their databases and grant per-table privileges (§16.2).
- Row volumes and sizes are in the order of the Phase 1 mock (§18.1).
- An external worker environment can reach Supabase via IPv4 pooler endpoints and the chosen storage provider.
- Q-B1 is resolved so that a control-plane project (and a disposable prototype project) can exist.

### 22.5 Trade-offs accepted

- **Credential concentration** in one worker (mitigated by least privilege, secret references, kill switch; sidecar path available).
- **Manual approval per deletion** (safe at 3 apps; fatigue at 50 apps; §18.3).
- **Space is reused, not returned** after deletes. Archival buys runway; it does not shrink the reported database size quickly (§7.4).
- **Stragglers** fragment archives slightly across jobs (§4.4).
- **Undeclared logical relationships** between tables cannot be discovered (§5.4).

### 22.6 Unresolved risks

1. **Irreversibility without backups** (Free plan). A corrupted archive discovered after deletion is permanent loss. Mitigation (safety dump or second copy) is UNDECIDED (Q-B9).
2. **Read-only cliff:** if a DB crosses 500 MB before remediation, deletion itself is blocked. It depends on early alerting and capacity values (Q-B5).
3. **Legal residency and erasure** answers may force a specific provider and an archive-rewrite capability (Q-L1, Q-L4).
4. **Supabase platform changes:** compute and quotas are documented as "subject to change" **[FACT]**. The ADR's numbers must be re-verified before rollout.
5. **Prices in §8 are indicative only** (official pages not accessible during research).
6. **RLS on source tables** may block archiver reads (P-6). This fails safe but could stall the rollout.

---

## 23. Phase 3 implementation plan

Order matters: **read-only value first, destructive capability last, behind switches.**

| Step | Scope | Destructive? |
|---|---|---|
| 0 | Resolve blocking questions **Q-B1** (projects/plans) and **Q-L1** (data location); answer Q-B2/B4/B5/B7/B9 if possible | No |
| 1 | Prototypes **P-1…P-10** in a disposable project with synthetic data. Record measurements in an addendum to this ADR. | Only on synthetic data |
| 2 | Control-plane schema design + migrations **for the central project only** (registry, policies, snapshots, jobs, steps, batches, approvals, audit) | No |
| 3 | **Read-only live monitoring:** `uniqbotz_monitor` role per app; server-side `InfrastructureDataSource` for applications, tables, health and growth; production authentication and roles | No |
| 4 | Policy persistence + PK/date/FK/trigger discovery + validation + graph hash | No |
| 5 | Live candidate previews (selection only) | No |
| 6 | Worker: **export + verify only** ("archive-only mode"); deletion code absent or disabled by a global kill switch that defaults to ON | No (writes archives only) |
| 7 | Deletion behind a feature flag: first on the disposable project, then one low-risk table in one app, with manual approval; review results before widening | **Yes, gated** |
| 8 | Alert delivery (WhatsApp/email), escalation, recovery, duplicate suppression | No |
| Later | Archive retention/purge, erasure rewrite, restore tooling, optional sidecars, partitioning for the largest tables | Varies |

Phase 3 must keep Phase 1's safety rules visible in the UI and add the new states and fields from Appendix A.

---

## Appendix A — Phase 1 contract changes implied by this record

*(Documented only. Nothing below is implemented in Phase 2.)*

| Contract | Change |
|---|---|
| `ArchiveJobStatus` | Add `queued`, `deletion_approved`, `verifying_deletion`, `waiting_retry`, `cancelled`, `expired`. Narrow `failed` to "0 deleted". Add an exceptions flag on `completed`. |
| `ArchiveDeletion` | Add `driftedCount`, `missingCount`; batch-level history. |
| `ArchiveVerification` | Replace the single `checksumMatch` with a list of named checks (V1–V8) with result, counts, timestamps and verifier version. `isDeletionAllowed` requires all gate checks to pass plus verification not expired. |
| `ArchiveJob` | Add `attempt`, `manifestLocation`, `schemaHash`, `fkGraphHash`, `timeZone`, `approvals[]`, `lease` (internal), `killSwitchState`. |
| `RetentionPolicy` | Add `gracePeriodDaysOverride`, `settledGuard` (column + days), `tableGroup` / `rootTable`, `dataClassification`, `retentionPurpose`, `archiveRetention`, `thresholdOverride` (optional). |
| `Application` | Add `timeZone`, `plan` (free/pro), `capacityMb` source, `roles` (reference only). |
| `TableHealth` | Add `rowCountKind: "estimate" \| "exact"`, `countMeasuredAt`, `deadTuples`, `hasPrimaryKey`, `fkEdges`, `triggers`; include non-`public` schemas in database-level views. |
| `ArchiveCandidate` | Add `nullDateCount`, `stragglerDays`, `rootTable`, `fkGroup`, `status: "ready" \| "insufficient" \| "blocked"`. |
| `InfrastructureSettings` | Add `killSwitch` (global), `verificationValidityDays`, `defaultTimeZone`; keep `archiveVerificationRequired: true`. |
| `InfrastructureDataSource` | Replace `simulateDeletionConfirmation` with `approveDeletion(jobId)`. The UI only approves; the worker executes. Add `cancelJob`, `resumeJob`, `createJob(candidateId)`, `setKillSwitch`. |
| Mock data | Jalsa multi-table candidate → root-driven group (§5.3). Remove the hard-coded "Children first" text from `JOB-00123`. |

---

## Appendix B — Sources

Accessed 2026-09-30.

**Research limitations:** the environment's network proxy blocked direct page fetches for most vendor sites.

- Supabase facts were read from Supabase's official documentation through its documentation search tool (page text returned with URLs).
- Storage and legal facts were read from **search-result excerpts** of the listed pages; several could not be opened in full.
- Items marked indicative, or from secondary sources, must be re-checked.

**Supabase (official docs)**

- Database size, read-only mode, VACUUM notes — https://supabase.com/docs/guides/platform/database-size
- Free project pausing — https://supabase.com/docs/guides/platform/free-project-pausing
- Billing FAQ (2 free projects, fair use) — https://supabase.com/docs/guides/platform/billing-faq · https://supabase.com/docs/guides/platform/billing-on-supabase
- Egress — https://supabase.com/docs/guides/platform/manage-your-usage/egress
- Storage size / file limits — https://supabase.com/docs/guides/platform/manage-your-usage/storage-size · https://supabase.com/docs/guides/storage/uploads/file-limits
- Storage S3 compatibility (no versioning/lifecycle/object lock) — https://supabase.com/docs/guides/storage/s3/compatibility
- Edge Function limits / background tasks / wall-clock — https://supabase.com/docs/guides/functions/limits · https://supabase.com/docs/guides/functions/background-tasks
- Compute and disk — https://supabase.com/docs/guides/platform/compute-and-disk
- Timeouts — https://supabase.com/docs/guides/database/postgres/timeouts
- Cron — https://supabase.com/docs/guides/cron · pg_net — https://supabase.com/docs/guides/database/extensions/pg_net
- Vault — https://supabase.com/docs/guides/database/vault
- Backups — https://supabase.com/docs/guides/platform/backups · https://supabase.com/docs/guides/deployment/going-into-prod
- Connecting / IPv4 — https://supabase.com/docs/guides/database/connecting-to-postgres · https://supabase.com/docs/guides/platform/ipv4-address
- pg_repack — https://supabase.com/docs/guides/database/extensions/pg_repack
- API keys / roles — https://supabase.com/docs/guides/getting-started/api-keys · https://supabase.com/docs/guides/database/postgres/roles
- Inspect/CLI — https://supabase.com/docs/guides/observability/inspect
- Regions — https://supabase.com/docs/guides/platform/regions

**Object storage** (excerpts; prices indicative)

- AWS S3 storage classes / Object Lock / default encryption / free tier — https://docs.aws.amazon.com/AmazonS3/latest/userguide/storage-class-intro.html · https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock.html · https://aws.amazon.com/s3/storage-classes/ · https://aws.amazon.com/free/
- Cloudflare R2 pricing, data location, bucket locks, lifecycle, durability — https://developers.cloudflare.com/r2/pricing/ · https://developers.cloudflare.com/r2/reference/data-location/ · https://developers.cloudflare.com/r2/buckets/bucket-locks/ · https://developers.cloudflare.com/r2/buckets/object-lifecycles/ · https://developers.cloudflare.com/r2/reference/durability/
- Backblaze B2 pricing, regions, Object Lock, SSE — https://www.backblaze.com/cloud-storage/pricing · https://www.backblaze.com/docs/cloud-storage-data-regions · https://www.backblaze.com/docs/cloud-storage-object-lock · https://www.backblaze.com/docs/cloud-storage-server-side-encryption
- Wasabi pricing, minimum duration, regions — https://wasabi.com/pricing · https://docs.wasabi.com/docs/how-does-wasabis-minimum-storage-duration-policy-work · https://wasabi.com/company/storage-regions
- Google Cloud Storage pricing, bucket/object lock, CMEK — https://cloud.google.com/storage/pricing · https://docs.cloud.google.com/storage/docs/bucket-lock · https://docs.cloud.google.com/storage/docs/encryption/customer-managed-keys

**India data protection** (facts only; not legal advice)

- DPDP Rules 2025 notification (PIB) — https://www.pib.gov.in/PressReleasePage.aspx?PRID=2190655
- Rule summaries (secondary) — https://www.dpdpa.com/dpdparules/rule6.html · https://www.dpdpa.com/dpdparules/rule8.html · https://www.dpdpa.com/dpdparules/rule15.html
- CERT-In Directions 28.04.2022 — https://www.cert-in.org.in/PDF/CERT-In_Directions_70B_28.04.2022.pdf

**PostgreSQL** (general behaviour cited as [PG]): official documentation on MVCC, `VACUUM`, `pg_constraint`, `COPY`, transaction isolation, `session_replication_role`.

---

## Phase 3A Validation Status

Added 2026-09-30. The decisions above are **not rewritten**. Full evidence is in
[`PHASE_3A_TECHNICAL_VALIDATION_REPORT.md`](./PHASE_3A_TECHNICAL_VALIDATION_REPORT.md) (code: `prototype/`, results: `prototype/results/`).

**Test conditions:** synthetic data only, on the official `supabase/postgres:17.6.1.066` image run locally (0.5 CPU / 512 MB). **No hosted Supabase project was used.** 161/161 prototype checks passed.

### Prototype findings (measured)

| Area | Finding | Effect on this ADR |
|---|---|---|
| Schema drift (§2, A-2) | Row fingerprint misses rename / type / constraint / FK changes | A-2 **partially disproved**. A schema+graph hash check before deletion is mandatory. |
| Freeze (D-03) | Selection outside the snapshot disagrees with frozen rows under concurrent inserts | **Refined:** whole-day selection runs inside the freeze snapshot |
| Verification (D-13) | A consistently re-hashed altered row is caught only by restore + fingerprint (V8) | **Changed:** V8 is part of the gate on every job, not sampled (~1 s per 125k rows) |
| RLS (§16.2) | RLS silently hides rows; post-deletion reconciliation is blind too | Catalog RLS preflight mandatory; BYPASSRLS role or explicit policies |
| Space (§7.4) | DELETE never shrinks the DB; reuse depends on vacuum timing; VACUUM FULL blocks reads | Explicit `VACUUM (ANALYZE)` after each job; VACUUM FULL stays manual |
| Deletion (§11) | Nested `BEGIN` let the deleter commit a caller's transaction | Deleter owns its transaction; nested use refused |
| Batches (D-14) | 2,000 comfortable, 10,000 degrades sharply | Default 2,000, cap 5,000 (re-measure on hosted) |
| Format (D-12) | CSV.GZ exact and fastest; typical JS Parquet mapping lossy | Confirmed |
| FK groups (D-08), leases/states (D-18/D-19), straggler pickup (D-05), whole-day rule (§3) | Behaved as designed | Confirmed |

### Still architecture assumptions (not yet validated)

- Hosted Supabase:
  - Supavisor session-mode login with a custom role over IPv4
  - hosted BYPASSRLS
  - Nano timings
  - read-only enforcement
  - egress
- Object storage provider behaviour (P-7).
- Real application schemas (P-5).
- Grace values (D-07).
- Monitoring and count estimates (D-15, D-21).
- Authentication (D-20).
- All business and legal questions in §21.2 remain **UNDECIDED**.

## Phase 3B Implementation Status

Phase 3B implemented Option 2 (central external worker plus a separate control plane) with **read-only** live monitoring and
`ARCHIVE_AND_VERIFY_ONLY` jobs. The deletion engine follows §11 but is **disabled**:

- `ALLOW_DELETION=false` by default;
- kill switch ON by default;
- only `synthetic` environments allow-listed.

Scheduling and notifications are constrained off. Hosted-Supabase validation is still outstanding. Details, and the ordered prerequisites before any production deletion, are in `PHASE_3B_IMPLEMENTATION_RECORD.md`.
