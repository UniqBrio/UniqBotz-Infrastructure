# Control-Plane Security

Scope: authentication, authorization, roles, secret management and logging for UniqBotz Infrastructure, as implemented in Phase 3C.

Decisions still owed are listed in `PRODUCTION_DECISION_CHECKLIST.md` (S-1…S-7, A-1…A-9).

## 1. Trust boundary

```
Browser ──HTTPS──▶ Next.js server (/api/infra/*) ──read-only pool──▶ CONTROL PLANE (schema control)
                     │ authenticate (token) + authorize (roles from control plane)
                     └─writer connection (mutations only)──▶ CONTROL PLANE
Worker (manual CLI) ──────────────────────────────────────────▶ CONTROL PLANE
   └─ resolves env: secret references ──▶ APPLICATION DATABASES (monitor / archive roles)
                                      └─▶ ARCHIVE STORAGE (provider not chosen)
```

The browser never receives any of the following:

- Supabase service keys;
- database passwords;
- archive-storage credentials;
- worker secrets;
- the token-signing secret.

All of these are resolved server-side from **secret references**. A production-build check confirmed that the client bundle contains no control-plane credential variable, signing-secret reference, or approval/authorization internals.

The web tier **never connects to application databases**. Only the worker does.

## 2. Authentication (server-side)

| Setting | Meaning |
|---|---|
| `CONTROL_PLANE_AUTH_MODE` | unset / `disabled` → **AUTHENTICATION NOT CONFIGURED**. `jwt-hs256` → session tokens verified on the server |
| `CONTROL_PLANE_AUTH_SECRET_REF` | `env:NAME` reference to the token-signing secret (never the value) |
| `CONTROL_PLANE_AUTH_ISSUER`, `CONTROL_PLANE_AUTH_AUDIENCE` | Required. There are no defaults |
| `CONTROL_PLANE_AUTH_MAX_AGE_SECONDS` | Optional maximum session age |

- **Verifier** (`src/server/auth/jwt.ts`):
  - It is strict HS256: `alg` must be HS256 (`none` is rejected), the signature is compared in constant time, and `exp` is required.
  - `nbf`, `iss`, `aud` and `sub` are checked, plus an optional maximum age.
  - It is isolated so that an asymmetric (JWKS) verifier can replace it once the identity provider is chosen (S-1).
- **Identity vs roles.** The token proves *who* the user is. **Roles come only from `control.operator_roles`.** Role claims inside tokens are ignored; a test proves this.
- **CSRF.** Reads accept the `uniqbotz_session` cookie. **Writes require `Authorization: Bearer`**, so a cross-site request carrying only the cookie cannot change anything (`CSRF_PROTECTION`).
- **When authentication is NOT configured:**
  - every write returns `403 READ-ONLY: AUTHENTICATION NOT CONFIGURED`;
  - anonymous reads are allowed **only while no production application is registered**. Once one is registered, reads return `401 AUTHENTICATION NOT CONFIGURED — production application data requires authentication`.
- **Misconfiguration fails closed.** A missing issuer, audience or secret reference, an inline secret value, or an unresolvable secret all yield AUTHENTICATION NOT CONFIGURED.

## 3. Roles and permissions

Source of truth: `src/lib/auth/permissions.ts`. Nobody holds any role until an ADMIN grants it. The bootstrap is `worker/cli.ts operator:add` and `operator:grant`, which are audited.

| Permission | VIEWER | OPERATOR | APPROVER | ADMIN | Notes |
|---|:-:|:-:|:-:|:-:|---|
| **View** health, tables, alerts, previews, jobs, audit | ✓ | ✓ | ✓ | ✓ | |
| **Policy editing** (draft: classify REVIEW_REQUIRED / DO_NOT_ARCHIVE, draft Archive values; cannot enable) | | ✓ | | ✓ | No dashboard write path yet (CLI/repository only) |
| **Changing retention** (date column, protected period, grace, target, enable Archive) | | | | ✓ | No dashboard write path yet |
| **Starting archive verification** (creates `ARCHIVE_AND_VERIFY_ONLY`, never deletes) | | ✓ | | | `POST /api/infra/jobs`. The mode is forced by the server |
| Cancel a job (not once deleting) | | ✓ | | ✓ | `POST /api/infra/jobs/:id/cancel` |
| **Approving deletion** (approve/reject, bound to the reviewed evidence) | | | ✓ | | `POST /api/infra/jobs/:id/approvals` |
| **Deletion authorization** (explicit, expiring; after the quorum; typed confirmation) | | | | ✓ | `POST /api/infra/jobs/:id/authorization` |
| **Executing deletion** | | | | | **Nobody. The worker only.** It re-validates every gate and refuses while `ALLOW_DELETION=false` |
| **Kill switch — engage** (stop) | | ✓ | ✓ | ✓ | `POST /api/infra/kill-switch {engaged:true}` |
| **Kill switch — release** (allow) | | | | ✓ | Releasing never enables deletion by itself |
| Change settings (thresholds, approval policy) | | | | ✓ | No dashboard write path yet |
| **Changing credentials** (hosts, users, secret references; never values) | | | | ✓ | CLI `register` only |
| Register applications / manage operators | | | | ✓ | CLI only |

**Separation of duties** (built in; confirmation owed as A-9):

- the authorizing ADMIN may never be one of the job's approvers;
- ADMIN does not include APPROVER;
- optionally, the job creator is excluded from approving (A-6).

**No single accidental UI action can delete.** The chain is:

1. N evidence-bound approvals;
2. a separate ADMIN authorization with a typed job ID;
3. the worker's own gate: `ALLOW_DELETION`, the environment allow-list, the kill switch, verification freshness, schema/graph hash, candidate integrity, and re-validation of the approvals, roles, expiry and window.

The dashboard has no delete button.

## 4. Secret management

Implemented in `worker/connection/secrets.ts`.

- **Reference format:** `env:NAME`, resolved from the process environment. `vault:NAME` is reserved for the managed store (S-3) and currently refuses with `SECRET_STORE_NOT_CONFIGURED`.
- **Kinds:**

| Kind | Used for |
|---|---|
| `DATABASE_CONNECTION` | Monitor, archive and control-plane database passwords |
| `ARCHIVE_STORAGE` | Archive bucket credentials (provider not chosen) |
| `APPLICATION_CREDENTIAL` | Other credentials, e.g. the control-plane token-signing secret. **Never** a Supabase service-role key (ADR §16.2) |
| `MESSAGING` | WhatsApp/email provider credentials (sending disabled) |

- **Storage rule.** The control plane stores references only. A database CHECK rejects anything that is not `env:`/`vault:` + name, and `validateApplicationConfig` rejects literals.
- **Missing secret.**
  - Raises `SecretError(SECRET_MISSING)`, classified as a **configuration** failure.
  - It is never retried in a loop: jobs go to `failed` with the audit action `readiness_blocked`, and collections set `connection_status = not_configured`.
  - The value is never defaulted.
- **Invalid reference.** `SECRET_REF_INVALID`. The literal is not echoed in the error.
- **Revocation.** `SECRET_REVOKED`.
  - Revoke at the source: rotate the password or disable the role in the application database.
  - Remove the value from the worker environment.
  - Add the reference to `SECRETS_REVOKED` (comma-separated) until it is replaced.
  - Revoked references are refused immediately. There is no cache.
- **Rotation**, with dual-credential rollover (cadence is S-4):
  1. Create the new password or role in the application database.
  2. Set the new secret value in the worker platform, under a **new** reference name, e.g. `env:ROSIFIT_MONITOR_PASSWORD_2026Q4`.
  3. Update the connection's `password_secret_ref` with `register`, which is audited.
  4. Run `collect` to verify connectivity.
  5. Revoke and drop the old credential; add the old reference to `SECRETS_REVOKED`.
  6. Audit the change. Also rotate immediately on staff change or suspicion.
- **Failure behaviour.**
  - An authentication rejection by the database (28P01/28000) is recoverable, with backoff: `waiting_retry`, never a login loop.
  - A secret that cannot be resolved is a configuration block.

## 5. Observability and logging

Implemented in `worker/observability/logger.ts`.

- **Format.** One JSON object per line.
- **Allowed fields:**
  - `application`, `jobId`, `table`, `phase`, `durationMs`, `rows`, `batch`, `retry`, `worker`, `archiveObject`, `checksum`;
  - `attempt`, `status`, `errorKind`, `error`.
- **Not logged.** Any other field (for example a row object) is dropped. Row data is not an accepted field; counts are.
- **Redaction** applies to every string value and error message. It removes:
  - connection-string passwords;
  - `Bearer` tokens and JWTs;
  - Supabase `sb_secret_…` / `sb_publishable_…` keys;
  - `password=`, `token=`, `api_key=`, `secret=` and `authorization=` values.
- **Never log:** passwords, tokens, service-role keys, secret values or personal records.
- **Notifications** follow the same rule. Message facts named like `phone`, `email`, `name`, `address`, `key`, `token`, `secret` or `password` are rejected.
- **Audit log.** `control.audit_logs` is the durable record and is append-only (UPDATE/DELETE/TRUNCATE refused by trigger). Phase 3C adds these actions:
  - `approval_recorded`, `approval_rejected`, `deletion_authorized`, `authorization_revoked`;
  - `access_denied`, `kill_switch_changed`, `readiness_blocked`;
  - `notification_suppressed`, `discovery_report`.
