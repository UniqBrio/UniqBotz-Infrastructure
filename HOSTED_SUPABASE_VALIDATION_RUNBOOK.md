# Hosted Supabase Validation Runbook

**Purpose:** validate the Phase 3B/3C worker assumptions on a real **hosted** Supabase project before any production connection. So far everything has been validated only on the official Supabase Postgres image running locally.

> **DISPOSABLE PROJECT + SYNTHETIC DATA ONLY.**
> - **Never** run this against RosiFit production (`lhpzhkzbnquwjljmbylo`) or any project holding real data. The script refuses that ref by name.
> - The project must be created **explicitly by its owner** for this purpose (checklist SB-4). Claude/automation must not create it.
> - Delete (or pause) the project when finished.

Tooling: `worker/hosted-validation/validate.ts`. It runs the 16 checks below and writes a JSON evidence file. Items it cannot safely automate are reported as `manual`.

---

## 1. Preconditions

| # | Precondition | Who |
|---|---|---|
| P-1 | A **new** Supabase project, e.g. `uniqbotz-hosted-validation`, on the **same plan/compute** as the future production apps (Free/Nano if that is the plan) and in the intended region | Owner |
| P-2 | The project contains **no data**: an empty `public` schema. The script refuses a non-empty `public` schema | Owner |
| P-3 | The machine running the script can reach the database on 5432/6543. The Claude Code web sandbox cannot (HTTPS only), so run from a workstation or the future worker host | Owner |
| P-4 | Connection strings from the dashboard (Connect → direct, session pooler, transaction pooler), and the Supabase CA certificate (Database settings → SSL) | Owner |
| P-5 | A synthetic password (≥ 16 chars) for the temporary validation roles | Owner |

## 2. Run

```bash
# Rehearse locally first (optional; uses the local Docker image; no TLS):
prototype/scripts/start-db.sh
docker exec uniqbotz-proto psql -U postgres -h 127.0.0.1 -c "CREATE DATABASE hv_rehearsal"
HV_LOCAL_REHEARSAL=1 HV_PROJECT_REF=local-rehearsal HV_CONFIRM_DISPOSABLE=I-CONFIRM-local-rehearsal-IS-DISPOSABLE \
HV_OWNER_URL=postgres://postgres:prototype-local-only@127.0.0.1:54329/hv_rehearsal \
HV_POOLER_SESSION_URL=postgres://postgres:prototype-local-only@127.0.0.1:54329/hv_rehearsal \
HV_ROLE_PASSWORD=synthetic-rehearsal-password npx tsx worker/hosted-validation/validate.ts

# Hosted (values come from the owner; never commit them):
export HV_PROJECT_REF=<disposable-ref>
export HV_CONFIRM_DISPOSABLE=I-CONFIRM-<disposable-ref>-IS-DISPOSABLE
export HV_OWNER_URL='postgres://postgres:<pw>@db.<ref>.supabase.co:5432/postgres'
export HV_POOLER_SESSION_URL='postgres://postgres.<ref>:<pw>@aws-0-<region>.pooler.supabase.com:5432/postgres'
export HV_POOLER_TRANSACTION_URL='postgres://postgres.<ref>:<pw>@aws-0-<region>.pooler.supabase.com:6543/postgres'
export HV_CA_CERT=./prod-ca-2021.crt
export HV_ROLE_PASSWORD='<synthetic ≥16 chars>'
npx tsx worker/hosted-validation/validate.ts      # writes hosted-validation-results/<ref>-<time>.json
```

The script creates `uniqbotz_validation_marker`, `hv_parent` (50,000 synthetic rows), `hv_child` and `hv_rls` in the disposable database, plus three temporary roles. It drops the roles at the end.

## 3. The 16 checks

| # | Check | How (automated unless *manual*) | Pass criterion | Why it matters |
|---|---|---|---|---|
| 1 | **Connection pooler** | Session-mode and transaction-mode URLs: `REPEATABLE READ READ ONLY` snapshot, then pinned session settings (`SET TimeZone`…) | Snapshot consistent; session mode keeps `SET` | Fingerprints depend on pinned settings (Phase 3A P1). Transaction mode resets session state, so the worker must use **session mode or direct** |
| 2 | **SSL certificate verification** | `rejectUnauthorized: true` with the Supabase CA; `pg_stat_ssl` | TLS on, certificate verified | `sslMode: verify-full` for every production connection |
| 3 | **IPv4 connectivity** | DNS A records of the direct host | Documented path: direct IPv6, IPv4 add-on, or pooler | Many worker hosts are IPv4-only |
| 4 | **Custom role** | `CREATE ROLE … LOGIN` with role-level `statement_timeout`/`lock_timeout` | Created and usable | Least-privilege monitor/archiver roles (ADR §16.2) |
| 5 | **Least privilege** | Monitor INSERT; archiver UPDATE/TRUNCATE/DDL/CREATE ROLE | All `42501` | Roles cannot exceed their purpose |
| 6 | **RLS** | Non-bypass archiver counts `hv_rls`; `planGroup` preflight | Sees fewer rows; plan **blocked** (`rls_hides_rows`) | RLS silently hides rows (Phase 3A P9) |
| 7 | **BYPASSRLS behaviour** | `CREATE ROLE … BYPASSRLS` as `postgres`; count | Allowed and sees all rows, **or** documented refusal (then use archiver-scoped RLS policies) | Decides how RLS tables can ever be archived |
| 8 | **Schema introspection** | `discoverDatabase` as the monitor role | Tables, FK with `CASCADE`, insertion column visible | Discovery must work with least privilege |
| 9 | **Exact row count** | `count(*)` of 50,000 rows, timed | Correct; time recorded | Exact counts near thresholds (cost on Nano) |
| 10 | **Snapshot behaviour** | Concurrent insert while an RR READ ONLY snapshot is open | Count unchanged inside the snapshot | Freeze correctness (candidate selection inside the snapshot) |
| 11 | **Export timing** | `COPY … TO STDOUT` of 50,000 rows, timed | Completes; bytes and ms recorded | Export duration vs statement timeouts and egress |
| 12 | **Delete batch timing** | `deleteBatch` of 2,000 exact keys + fingerprints on **synthetic** `hv_parent` | 2,000 deleted; ms recorded | Batch size 2,000 is a default, not proven optimal on hosted compute |
| 13 | **Locks** | Hold a row lock in one session; delete it with `lock_timeout = 1s` in another | `55P03` within ~1 s | Worker retries lock timeouts and never waits unbounded |
| 14 | **Read-only mode** | Session read-only write attempt; *manual:* observe Free-plan disk-full read-only behaviour (do **not** fill a shared project) | `25006`; worker classifies `read_only` and never auto-escapes | Free plan goes read-only when full |
| 15 | **Database size** | `pg_database_size` — *manual:* compare with the dashboard and plan quota | Values reconcile (record the difference) | Capacity alerts use this number |
| 16 | **Statistics visibility** | `pg_stat_user_tables` as the monitor role | `n_live_tup`, `n_dead_tup`, vacuum times visible | Health collection without superuser |

Also record these, manually:

- round-trip latency from the worker host;
- the effect of the pooler's connection limits when running `CONNECTION LIMIT 2` roles;
- whether `VACUUM (ANALYZE)` by the archiver requires `MAINTAIN` (PG17) on hosted.

## 4. Evidence and sign-off

1. Commit the JSON evidence file (it contains no secrets) under `hosted-validation-results/`, together with a short summary: pass/fail/manual per check, and the timings for 9, 11 and 12.
2. Any `fail` blocks the production pilot until it is explained or fixed.
3. Every `manual` item needs a written observation.
4. Sign-off: the operator who ran it, plus a reviewer. Attach it to the Phase 3D request together with `PRODUCTION_DECISION_CHECKLIST.md`.
5. Pause or delete the disposable project.

## 5. What this does **not** validate

- RosiFit's own schema, data volumes and RLS policies. Those come from the READ-ONLY discovery (`ROSIFIT_READ_ONLY_DISCOVERY_REPORT.md`).
- The archive provider. None has been chosen (AR-1).
- The identity provider (S-1).
