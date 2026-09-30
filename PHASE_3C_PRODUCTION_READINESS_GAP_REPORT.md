# Phase 3C — Production Readiness Gap Report

**Phase 3C is production-readiness preparation, not production enablement.**

```
READ-ONLY MONITORING:      IMPLEMENTED
ARCHIVE-AND-VERIFY:        IMPLEMENTED / TESTED (synthetic, local)
PRODUCTION DELETION:       DISABLED
AUTOMATED SCHEDULING:      DISABLED
PRODUCTION NOTIFICATIONS:  DISABLED
```

**The system is NOT production-ready.** It builds and every test passes, but production use is blocked on the business decisions in `PRODUCTION_DECISION_CHECKLIST.md`, on hosted-Supabase validation, and on the missing components listed in §3.

---

## 1. Review of what existed after Phase 3B

Classification:

- **complete**: fit for purpose at the current scope;
- **incomplete**: works, but is missing something production needs;
- **placeholder**: stands in for a real component;
- **unsafe for production**: must not be used against production as it stood;
- **blocked**: waiting on an external decision.

| Area | Phase 3B state | Classification | Phase 3C action |
|---|---|---|---|
| Control-plane schema (0001, 19 tables) | Safety constraints, append-only audit, kill switch ON by default | complete | 0002 adds operators/roles, approvals, authorizations, a NULL approval policy, disabled schedules/outbox, nullable app time zone, `production_is_read_only` |
| Worker discovery / health | Read-only monitor session; REVIEW_REQUIRED defaults; growth rules | complete (synthetic) | Explicit time zone required; missing secrets → `not_configured`; RLS-blind handling kept; read-only discovery report + monitor write-privilege audit |
| Live data source + API | GET-only, anonymous, read-only DB session | **unsafe for production** (no authentication; any viewer sees production data) | Authentication boundary; anonymous reads refused once a production app is registered; role-checked mutations through a separate writer credential |
| Authentication assumptions | "Writes refused until auth exists" | **placeholder** | Implemented: server-side token verification, roles from the control plane, CSRF-safe writes. Provider choice still open (S-1) |
| Archive interface | `ArchiveStore` + local directory (used for every environment) | **placeholder** / unsafe (local directory could have been used for any app) | Provider-neutral `ArchiveStorage` (upload/read/exists/metadata/checksum/versions/purge/discard). Local directory approved for **synthetic only**; no provider → ARCHIVE EXECUTION UNAVAILABLE; purge disabled |
| Verification gate | 6 stages incl. full restore | complete | Unchanged; provider-failure and checksum tests added |
| Deletion gate | ALLOW_DELETION, environment allow-list, kill switch, mode, status, verification, hashes, integrity | incomplete (single-step CLI approval; no people/roles) | Human authorization chain added to the gate: evidence-bound approvals, quorum, expiry, separation of duties, explicit ADMIN authorization, deletion window; re-checked per batch |
| Kill switch | DB flag, default ON; changed only by SQL | incomplete | Role-checked engage (OPERATOR+) / release (ADMIN), audited, concurrency-safe |
| Settings | Thresholds 10L/11L/12L; capacity NOT FINAL; grace NULL | complete (values pending) | Approval-policy fields added, all NULL |
| Retention policies | REVIEW_REQUIRED default; validation | complete | Standard fail-safe messages (`CANNOT RUN — …`) |
| Secrets | `env:` resolver only | incomplete | Secret kinds, `SecretManager`, revocation, fail-closed errors, `vault:` refusal; rotation documented |
| Scheduling | Disabled by DB CHECK | complete (disabled) | Interface + eligibility contract; `DisabledScheduler` |
| Notifications | Disabled by DB CHECK | complete (disabled) | Interface; the outbox records `suppressed` only (DB CHECK) |
| Logging | Audit log only | incomplete | Structured, allow-listed, redacting worker logger |
| Tests | 67 unit, 45 integration, 161 Phase 3A checks | complete for 3B | 120 unit, 83 integration; 161/161 still pass |
| Documentation | 3B record, ADR, README | complete for 3B | This report plus checklists, runbooks, the pilot plan, and security |
| Hosted Supabase | Not validated | **blocked** (SB-4) | Runbook + guarded validation script (rehearsed locally) |
| Real application discovery | None | **blocked** (production reads not permitted in this session; SB-1/SB-2) | Procedure + report tooling; RosiFit report prepared, facts vs assumptions separated |

## 2. What Phase 3C implemented

| Requirement | Where | Tests |
|---|---|---|
| Fail-safe messages; no silent defaults | `worker/readiness/blockers.ts`; policy validation; `createJob`; collector; runner | `readiness.test.ts`, `production-readiness.int.test.ts` |
| Authentication boundary | `src/server/auth/{jwt,session}.ts`; route handler | `src/server/auth/auth.test.ts` (24), `api-auth.int.test.ts` |
| Roles VIEWER / OPERATOR / APPROVER / ADMIN | `src/lib/auth/permissions.ts`; `control.operator_roles` | matrix tests; integration |
| Approval workflow (execution disabled) | `worker/approvals/approvals.ts`; `/api/infra/jobs/:id/{review,approvals,authorization}`; `DeletionApprovalPanel` | approval, expiry, duplicate, concurrency, separation of duties |
| Production deletion gate (9 requirements) | `evaluateDeletionGate` + `validateExecutionAuthorization`; per-batch revalidation | fully authorized job still refused with `ALLOW_DELETION=false`; expired, out-of-window and revoked mid-run cases |
| Secret abstraction | `worker/connection/secrets.ts` | missing / revoked / invalid / unsupported |
| Archive storage abstraction | `worker/archive/storage.ts`, `providers/` | provider unavailable, not approved, upload failure → retry, checksum |
| Hosted validation | `HOSTED_SUPABASE_VALIDATION_RUNBOOK.md`, `worker/hosted-validation/validate.ts` | safety-rail unit tests; local rehearsal: 15 pass, 2 skipped (TLS, transaction pooler), 2 manual |
| Read-only discovery | `worker/discovery/{readOnlyDiscovery,report}.ts`; CLI `discover` | synthetic end-to-end report; write-privilege warning |
| RosiFit first | `ROSIFIT_READ_ONLY_DISCOVERY_REPORT.md` | procedure only (see §4) |
| Pilot design | `PRODUCTION_PILOT_PLAN.md` | — |
| Scheduling / notification interfaces | `worker/scheduling`, `worker/notifications`; migration 0002 CHECKs | unit + DB constraint tests |
| Runbooks | `PRODUCTION_ARCHIVE_RUNBOOK.md`, `PRODUCTION_DELETION_CHECKLIST.md` | — |
| Observability | `worker/observability/logger.ts`; runner events | redaction / allow-list tests |

## 3. Still missing for production (engineering)

| # | Gap | Blocked by |
|---|---|---|
| G-1 | Archive provider adapter (S3-compatible / GCS / Supabase Storage) | AR-1, AR-2, L-1 |
| G-2 | Identity-provider integration: login flow and a JWKS verifier if asymmetric tokens are used | S-1 |
| G-3 | `vault:` secret backend | S-3 |
| G-4 | Dashboard write paths for policy/settings/credentials edits (permissions are defined; the endpoints are not built) | S-1, S-2 (can be built once auth is live) |
| G-5 | Operator review workflow for `requires_review` jobs (resolve / retry / abandon) | — |
| G-6 | Safety copy before deletion | AR-5 |
| G-7 | Archive restore tooling (scratch restore exists inside verification; an operator restore command does not) | — |
| G-8 | Audit-log export and retention; optional hash chaining | L-5 |
| G-9 | Hosted validation run on a disposable project | SB-4 (owner action) |
| G-10 | Real read-only discovery of RosiFit | SB-1/SB-2 + an authorized operator with network access |
| G-11 | Worker hosting and deployment (a process manager, env secrets, logs shipped to an approved location) | S-7, L-5 |
| G-12 | Behaviour decisions for below-target and oversized days (currently report-only / whole-day rule) | AP-7, AP-8 |

## 4. Honest notes

- **Real discovery was not performed.** A metadata-only read of the RosiFit production project through the Supabase connector was refused by this session's permission policy for production reads. It was not retried or worked around. The RosiFit report therefore contains only the Phase 3B project metadata as facts, and the rest is marked NOT YET OBSERVED.
- **Hosted validation was rehearsed locally only.** The rehearsal found and fixed two script issues:
  - a `SET` placed in the same multi-statement string as the write it guards does not apply to the implicit transaction already running;
  - Supabase's non-superuser `postgres` role cannot `DROP OWNED BY`, so the script now revokes grants explicitly before dropping roles.
  The worker itself was unaffected: it issues `SET` as separate statements.
- **The live smoke test found a misleading label, now fixed.** The safety-gate card read "DELETION: ALLOWED" for a verified `ARCHIVE_VERIFY_DELETE` job. Live views now always show deletion as DISABLED unless a (synthetic) deletion already ran, and tests cover it.
- **All approval-policy values used in tests are test-only.** No production values were chosen.
