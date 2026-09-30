# Production Archive Runbook

**Current state:**

```
READ-ONLY MONITORING: IMPLEMENTED · ARCHIVE-AND-VERIFY: IMPLEMENTED/TESTED (synthetic)
PRODUCTION DELETION: DISABLED · AUTOMATED SCHEDULING: DISABLED · PRODUCTION NOTIFICATIONS: DISABLED
```

This runbook describes how archive work **will** be operated. Steps marked **(future)** cannot be performed yet by design. Every command is manual; there is no scheduler.

Roles are described in `CONTROL_PLANE_SECURITY.md`. Open decisions are in `PRODUCTION_DECISION_CHECKLIST.md`.

---

## 1. Preflight (before any job)

| # | Check | How | Must be |
|---|---|---|---|
| 1 | Kill switch | Settings → Runtime safety state | **ON** (default), unless deliberately released for an authorized deletion window **(future)** |
| 2 | Worker configuration | `npx tsx worker/cli.ts status` | `ALLOW_DELETION=false`; allowed environments exclude `production` |
| 3 | Application health | `collect <app>` | `connected`; no `not_configured` |
| 4 | Required configuration | Candidate preview | Not `blocked`. Messages such as `CANNOT RUN — GRACE PERIOD NOT CONFIGURED` mean: stop and obtain the decision. **Never enter a guessed value** |
| 5 | Archive storage | Worker start-up | Provider configured and approved for the application environment; otherwise `ARCHIVE EXECUTION UNAVAILABLE` |
| 6 | Secrets | `collect` | No `SECRET_MISSING` / `SECRET_REVOKED` |
| 7 | Active jobs | Archive Jobs page | No active job for the same group (one-active-job rule) |
| 8 | Capacity | Database Health | Record the level; note that capacity thresholds are NOT FINAL |

## 2. Candidate review

1. Open **Archive Candidates**. The preview is read-only: nothing is frozen and no job is created.
2. Check:
   - oldest eligible day;
   - the proposed boundary (shown only when the target is reached);
   - the final-day count (whole days are never split);
   - exclusions (NULL dates, protected period, after the boundary);
   - FK group tables;
   - blocking reasons.
3. Discuss anything unexpected with the table owner. Record the review note.

## 3. Archive (freeze + export)

1. OPERATOR:
   - dashboard `POST /api/infra/jobs` (always `ARCHIVE_AND_VERIFY_ONLY`), or
   - CLI `job:create <app> <schema.table> <jobId>`.
2. Run: `VERIFY_SCRATCH_DATABASE_URL=… npx tsx worker/cli.ts job:run <jobId>`.
3. The worker then:
   - plans (RLS preflight, FK graph, PK check);
   - freezes and exports in one read-only snapshot;
   - uploads to storage;
   - records the manifest and checksums.
4. Structured logs (`archive_created`) show rows, archive object and checksum. They never contain row data.

## 4. Verification

- Runs automatically after export. All six stages must pass:
  1. objects exist;
  2. integrity (sha256, full gunzip);
  3. row counts;
  4. key set vs the control-plane frozen set;
  5. full restore + fingerprint reconciliation;
  6. schema hash.
- **Any failure → `failed`, `deleted: 0`.** Do not retry blindly; see §7.
- A success stops at `ready_for_deletion`. For a verify-only job this is the end state; it can never be approved.

## 5. Approval (future — deletion is disabled)

1. Only for jobs created in `ARCHIVE_VERIFY_DELETE` mode (not available from the dashboard).
2. APPROVERs open the job, review the **Deletion approval workflow** panel, and record approve or reject. Each decision is bound to:
   - the attempt;
   - the manifest checksum;
   - the schema hash;
   - the FK graph hash;
   - the candidate digest.
3. It only works once A-2…A-6 are decided. Until then: `DELETION NOT AUTHORIZED — APPROVAL POLICY NOT CONFIGURED`.
4. An ADMIN who is not one of the approvers issues the **authorization**: quorum, typed job ID, expiry.

## 6. Deletion (future — disabled)

The worker is the final authority. It refuses unless **every** one of these holds:

- `ALLOW_DELETION=true`;
- the environment is allow-listed;
- the kill switch is released;
- the job mode is `ARCHIVE_VERIFY_DELETE`, with status `deletion_approved`/`deleting`;
- the verification is fresh and passed for the current attempt;
- the schema and graph hash are unchanged;
- the candidate set is intact;
- the approvals are valid (unexpired, evidence-bound, approvers still hold the role, quorum, no rejection);
- the authorization is live and unexpired, and the authorizer still holds ADMIN;
- the current time is inside the deletion window.

Per batch, it re-checks:

- the kill switch;
- the schema/graph hash;
- the authorization (revoked or role removed → halt).

It deletes only exact frozen keys whose fingerprint is unchanged and which are not referenced by any row. Afterwards it reconciles, then runs `VACUUM (ANALYZE)` only (never `VACUUM FULL`).

`PRODUCTION_DELETION_CHECKLIST.md` must be completed and signed before this section is ever used.

## 7. Failure handling

| Symptom | Meaning | Action |
|---|---|---|
| `failed` + `readiness_blocked` audit | Configuration missing (grace, time zone, secret, storage) | Obtain the decision or fix the configuration. Re-create the job. No retry loop exists |
| `waiting_retry` (`transient`, `lock_timeout`, `storage`, `auth`) | Recoverable failure; exponential backoff | Let it retry, or cancel. Investigate if it repeats |
| `failed`, verification stage X | Archive not trustworthy | Keep the kill switch ON. Inspect the objects vs the manifest. A new job creates a new attempt |
| `requires_review` | Drift, kill switch engaged, authorization revoked, or reconciliation mismatch during deletion | Stop. Compare `archive_deletion_batches` with the reconciliation report. Escalate to ADMIN |
| `collection_failed` / `disconnected` | App database unreachable | Check network, credentials and the pooler. Monitoring shows stale data until fixed |

## 8. Rollback / recovery

- **Before deletion,** nothing in the application changed. Rollback = cancel the job. Archived objects remain (purge is disabled).
- **Worker crash:** leases expire; another worker takes over (audited `lease_takeover`) and resumes from the checkpoints. Superseded export attempts are discarded; completed batches are never re-deleted.
- **Restore (future, after any deletion):**
  - restore is privileged and audited;
  - restore into a **scratch** database first, from the verified archive (data CSV.GZ + `schema.json`);
  - re-insertion into production is a separate, approved operation and is never automatic;
  - FK parents must be restored before children.

## 9. Kill switch

- **Engage** (stop): OPERATOR, APPROVER or ADMIN, via `POST /api/infra/kill-switch {"engaged": true, "reason": …}` or the Settings page **(future UI)**. It takes effect before the next batch.
- **Release:** ADMIN only, with a reason. Release never enables deletion by itself.
- Every change is audited (`kill_switch_changed`), with who, when and why.

## 10. Incident response

1. **Engage the kill switch.**
2. If deletion was in progress:
   - note the job ID and batch number from `archive_deletion_batches`;
   - do **not** restart the worker until reviewed.
3. Revoke the authorization (`revokeAuthorization`), which also revokes approvals; the job returns to `ready_for_deletion` if not yet deleting.
4. **Credential exposure:**
   - revoke at the source;
   - add the reference to `SECRETS_REVOKED`;
   - rotate (`CONTROL_PLANE_SECURITY.md` §4);
   - review the audit log for use.
5. **Data exposure** (archive bucket or logs): follow the legal process (L-5/L-6; breach timelines per counsel).
6. Write an incident note with the timeline, taken from the audit log and the worker's structured logs.
