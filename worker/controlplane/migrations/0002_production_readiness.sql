-- UniqBotz Infrastructure — control-plane migration 0002 (Phase 3C: production-readiness preparation).
-- Adds the authorization model, approval/authorization records, and disabled scheduling/notification
-- interfaces. It does NOT enable deletion, scheduling or notifications, and it chooses NO business values:
-- every new policy setting is NULL ("not decided") and NULL means "refuse".

SET search_path = control;

-- ---------------------------------------------------------------- fail-safe configuration
-- An application's business time zone must be supplied explicitly (decision Q-B4). NULL → CANNOT RUN.
ALTER TABLE applications ALTER COLUMN time_zone DROP NOT NULL;
-- Phase 3C: production applications may be registered for READ-ONLY discovery/monitoring only.
-- Lifting this requires a reviewed migration after the production pilot is approved.
ALTER TABLE applications ADD CONSTRAINT production_is_read_only CHECK (NOT (environment = 'production' AND archive_enabled));

-- ---------------------------------------------------------------- operators and roles
CREATE TABLE operators (
  id            text PRIMARY KEY,                 -- stable subject from the identity provider (e.g. JWT "sub")
  email         text NOT NULL,
  display_name  text,
  active        boolean NOT NULL DEFAULT true,
  created_by    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  disabled_at   timestamptz
);
COMMENT ON TABLE operators IS 'People who may sign in to the control plane. Identity comes from the identity provider; ROLES come only from operator_roles (never from token claims).';

CREATE TABLE operator_roles (
  operator_id text NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  role        text NOT NULL CHECK (role IN ('VIEWER', 'OPERATOR', 'APPROVER', 'ADMIN')),
  granted_by  text NOT NULL,
  granted_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (operator_id, role)
);
COMMENT ON TABLE operator_roles IS 'Role grants. Who holds APPROVER/ADMIN is a business decision (checklist A-1); nobody holds a role until granted.';

-- ---------------------------------------------------------------- approval policy (all NULL = not decided = refuse)
ALTER TABLE system_settings
  ADD COLUMN approval_required_approvers   integer CHECK (approval_required_approvers >= 1),
  ADD COLUMN approval_validity_minutes     integer CHECK (approval_validity_minutes > 0),
  ADD COLUMN approval_excludes_job_creator boolean,
  ADD COLUMN authorization_validity_minutes integer CHECK (authorization_validity_minutes > 0),
  ADD COLUMN deletion_window_start         time,
  ADD COLUMN deletion_window_end           time,
  ADD COLUMN deletion_window_time_zone     text,
  ADD COLUMN kill_switch_changed_by        text,
  ADD COLUMN kill_switch_changed_at        timestamptz;
COMMENT ON COLUMN system_settings.approval_required_approvers IS 'Number of distinct APPROVERs required (two-person rule = 2). NULL → DELETION NOT AUTHORIZED.';
COMMENT ON COLUMN system_settings.approval_validity_minutes IS 'How long an approval stays valid. NULL → DELETION NOT AUTHORIZED.';
COMMENT ON COLUMN system_settings.deletion_window_start IS 'Allowed deletion window (local time in deletion_window_time_zone). NULL → DELETION NOT AUTHORIZED.';

-- ---------------------------------------------------------------- approvals and authorizations
CREATE TABLE deletion_approvals (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id           text NOT NULL REFERENCES archive_jobs(id) ON DELETE CASCADE,
  attempt          integer NOT NULL,
  operator_id      text NOT NULL REFERENCES operators(id),
  role_at_decision text NOT NULL CHECK (role_at_decision IN ('APPROVER', 'ADMIN')),
  decision         text NOT NULL CHECK (decision IN ('approve', 'reject')),
  comment          text,
  evidence         jsonb NOT NULL,   -- manifest sha256, schema hash, graph hash, candidate digest, verification id, candidate rows
  decided_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz,
  revoked_at       timestamptz,
  revoked_by       text,
  UNIQUE (job_id, attempt, operator_id)          -- one decision per person per attempt (duplicate approvals refused)
);
COMMENT ON TABLE deletion_approvals IS 'Approval decisions bound to the exact evidence (attempt, manifest, schema, candidates) that was reviewed. A new export attempt invalidates all earlier approvals.';

CREATE TABLE deletion_authorizations (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id           text NOT NULL REFERENCES archive_jobs(id) ON DELETE CASCADE,
  attempt          integer NOT NULL,
  operator_id      text NOT NULL REFERENCES operators(id),
  role_at_decision text NOT NULL CHECK (role_at_decision = 'ADMIN'),
  approval_ids     bigint[] NOT NULL,
  evidence         jsonb NOT NULL,
  authorized_at    timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  revoked_at       timestamptz,
  revoked_by       text,
  consumed_at      timestamptz                     -- set by the worker when execution starts
);
CREATE UNIQUE INDEX deletion_authorizations_one_live ON deletion_authorizations (job_id, attempt) WHERE revoked_at IS NULL;
COMMENT ON TABLE deletion_authorizations IS 'Explicit, expiring authorization of ONE job attempt for worker execution, issued after the approval quorum. The worker re-validates everything; this record alone deletes nothing.';

-- ---------------------------------------------------------------- scheduling interface (disabled)
CREATE TABLE archive_schedules (
  application_id text NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  group_root     text NOT NULL,
  cadence        text,                              -- e.g. a cron expression; undecided
  enabled        boolean NOT NULL DEFAULT false CHECK (enabled = false),  -- Phase 3C: SCHEDULING DISABLED
  last_evaluated_at timestamptz,
  last_evaluation jsonb,
  PRIMARY KEY (application_id, group_root)
);
COMMENT ON TABLE archive_schedules IS 'Schedule definitions for a future scheduler. Constrained disabled in Phase 3C; eligibility is evaluated and recorded only.';

-- ---------------------------------------------------------------- notification interface (disabled)
CREATE TABLE notification_outbox (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_type     text NOT NULL CHECK (event_type IN ('threshold_alert', 'archive_started', 'archive_verified', 'deletion_approved',
                                                    'deletion_completed', 'failure', 'recovery', 'database_critical')),
  application_id text,
  job_id         text,
  channel        text NOT NULL CHECK (channel IN ('whatsapp', 'email')),
  payload        jsonb NOT NULL,                    -- summary only: never personal records, never secrets
  status         text NOT NULL DEFAULT 'suppressed' CHECK (status = 'suppressed'),  -- Phase 3C: NOTIFICATIONS DISABLED
  reason         text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE notification_outbox IS 'Notifications that WOULD have been sent. Status is constrained to suppressed: nothing is delivered in Phase 3C.';
