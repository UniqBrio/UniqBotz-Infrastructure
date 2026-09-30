# Production Pilot Plan — Archive-and-Verify Only

> **DESIGN ONLY — NOT EXECUTED.**
>
> ```
> ONE APPLICATION
> ONE LOW-RISK TABLE
> READ / ARCHIVE / VERIFY ONLY
> ZERO DELETE
> ```
>
> A passed verification does **not** enable deletion. The first production deletion is a separate decision,
> with its own explicit production approval (`PRODUCTION_DELETION_CHECKLIST.md`).

## 1. Entry criteria (all required)

| # | Criterion | Evidence |
|---|---|---|
| E-1 | Decisions SB-1…SB-3, AP-1…AP-6 (for the pilot table), AP-9, AR-1…AR-3, S-1…S-3 and L-1 recorded | `PRODUCTION_DECISION_CHECKLIST.md` |
| E-2 | Hosted validation passed on a disposable project | `hosted-validation-results/*.json` + sign-off |
| E-3 | READ-ONLY discovery of the application completed and reviewed | `ROSIFIT_READ_ONLY_DISCOVERY_REPORT.md` §4 |
| E-4 | Archive provider adapter implemented for the chosen provider, and tested with the verification gate | provider tests |
| E-5 | Dashboard authentication live; operator, approver and admin roles granted to named people | `operator_roles` |
| E-6 | A reviewed migration lifts `production_is_read_only` **for the pilot application only** | migration PR |

## 2. Pilot scope

- **Application:** RosiFit (first, per the plan). This depends on E-3.
- **Table:** exactly one table chosen from the discovery report. It must meet **all** of:
  - single-column primary key;
  - a trustworthy temporal date column (AP-2);
  - **no other table references it** (a leaf), so the FK group is just the table itself;
  - no RLS, or RLS the archive role can legitimately see through (validated as hosted check 7);
  - not payment, financial, identity or configuration data;
  - enough eligible rows past the protected period and grace to reach a **small** pilot target (for example one or a few days of data);
  - owner agrees it is low risk.
- **Mode:** `ARCHIVE_AND_VERIFY_ONLY`. This is forced by the dashboard API, and is the CLI default.
- **Roles.** The production archive role gets `SELECT` on **that one table only**. It gets **no `DELETE` grant**, so even a software fault could not delete.
- **Deletion is impossible four independent ways:**
  - no `DELETE` privilege;
  - `ALLOW_DELETION=false`;
  - `DELETION_ALLOWED_ENVIRONMENTS` cannot contain `production`;
  - verify-only mode (approval is refused).

## 3. Procedure

| Step | What happens | Output / evidence |
|---|---|---|
| 1. **Preflight** | `discover` re-run (read-only); `collect`; confirm connection status, RLS findings, monitor write privileges = none, time zone configured, grace configured, storage provider approved for `production`, kill switch ON | discovery report diff; `collect` output |
| 2. **Candidate selection review** | Read-only preview in the dashboard: oldest eligible day, proposed boundary (shown only if the target is reached), final-day count, exclusions (NULL dates, protected period) | screenshot/export of the preview; operator note |
| 3. **Freeze** | `job:create rosifit public.<table> <jobId>` (verify-only) → `job:run`. Selection and export run in ONE `REPEATABLE READ READ ONLY` snapshot; exact PK + fingerprint keys are stored in the control plane | `candidates_frozen` audit; selection JSON |
| 4. **Archive** | CSV.GZ data + keys + `schema.json` + `manifest.json` uploaded to the approved provider/region, with sha256 per object | manifest; object list with sizes and checksums |
| 5. **Verification** | Six stages: objects exist → integrity (sha256, full gunzip) → row counts → key set vs control plane → **full restore into a scratch database and per-row fingerprint reconciliation** → schema hash unchanged | `archive_verifications.checks` (every check) |
| 6. **Reconciliation** | (a) frozen count = selection total = manifest rows = restored rows. (b) An independent read-only recount of source rows for the archived whole days, at review time, explained against late or backdated rows. (c) Restore a sample file to a scratch database and have the table owner eyeball it for sanity (no copies kept) | reconciliation sheet |
| 7. **Evidence package** | Discovery report, preview, job record, manifest, checksums, verification checks, audit-log extract, timings (export ms, verify ms), source-load observations (connections, CPU during export), egress estimate | one folder per pilot run |
| 8. **Operator sign-off** | The operator who ran it, an independent reviewer (APPROVER), and the table's business owner sign that the archive is complete, verified and restorable, and that **no row was deleted** | signed sign-off sheet |
| 9. **Close** | Cancel the job (it stays at `ready_for_deletion`, which is never approvable in verify-only mode). Keep the archive according to AR-3. The scratch database is dropped | `operator_action` audit |

Repeat for at least **3 cycles**, on different days, before any deletion discussion. Each cycle must pass without a manual fix.

## 4. Stop conditions (abort the pilot, keep the kill switch ON)

- Any verification stage fails. The job goes to `failed` with `deleted: 0`. Investigate before retrying.
- Source-database impact is above what the owner accepts (latency, connections, statement timeouts).
- Any unexpected write privilege, RLS surprise, or schema drift between discovery and freeze.
- An archive object is readable by anyone other than the intended roles.

## 5. After the pilot

A clean pilot produces evidence only. Moving to a first deletion requires, in addition:

- a new explicit production approval;
- the approval policy values (A-2…A-6);
- a safety copy decision (AR-5);
- the full `PRODUCTION_DELETION_CHECKLIST.md`.

The first deletion would again be one table, one small batch set, run manually in the deletion window, with the kill switch within reach.
