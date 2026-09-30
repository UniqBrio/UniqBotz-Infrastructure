-- UniqBotz Infrastructure — control-plane schema (Phase 3B).
-- Lives in the CENTRAL control-plane database only. Never applied to an application database.
-- Holds metadata, policies, job state and audit. Holds NO application row data except the exact
-- frozen candidate identities (PK + fingerprint) of in-flight jobs, and NO secret values.

CREATE SCHEMA IF NOT EXISTS control;
SET search_path = control;

-- ---------------------------------------------------------------- registry
CREATE TABLE applications (
  id                   text PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  name                 text NOT NULL,
  supabase_project_ref text,
  environment          text NOT NULL CHECK (environment IN ('synthetic', 'staging', 'production')),
  status               text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'disabled')),
  time_zone            text NOT NULL,
  enabled              boolean NOT NULL DEFAULT true,
  monitoring_enabled   boolean NOT NULL DEFAULT true,
  archive_enabled      boolean NOT NULL DEFAULT false,
  database_capacity_mb integer CHECK (database_capacity_mb > 0),
  connection_status    text NOT NULL DEFAULT 'not_configured'
                       CHECK (connection_status IN ('connected', 'degraded', 'disconnected', 'not_configured')),
  last_health_check_at timestamptz,
  last_error           text,
  database_bytes       bigint,
  server_version       text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE applications IS 'Registered UniqBotz applications (one independent Supabase project each) and their latest health summary.';

CREATE TABLE application_connections (
  application_id      text NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  purpose             text NOT NULL CHECK (purpose IN ('monitor', 'archive')),
  host                text NOT NULL,
  port                integer NOT NULL CHECK (port BETWEEN 1 AND 65535),
  database_name       text NOT NULL,
  username            text NOT NULL,
  password_secret_ref text NOT NULL CHECK (password_secret_ref ~ '^(env|vault):[A-Za-z_][A-Za-z0-9_]*$'),
  ssl_mode            text NOT NULL DEFAULT 'require' CHECK (ssl_mode IN ('disable', 'require', 'verify-full')),
  statement_timeout_ms integer,
  lock_timeout_ms     integer,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (application_id, purpose)
);
COMMENT ON TABLE application_connections IS 'Non-secret connection settings per application and purpose. Passwords are SECRET REFERENCES (env:NAME) resolved server-side by the worker, never values.';

-- ---------------------------------------------------------------- discovery
CREATE TABLE discovered_tables (
  application_id   text NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  schema_name      text NOT NULL,
  table_name       text NOT NULL,
  first_discovered_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  is_present       boolean NOT NULL DEFAULT true,
  primary_key      text[] NOT NULL DEFAULT '{}',
  rls_enabled      boolean NOT NULL DEFAULT false,
  rls_forced       boolean NOT NULL DEFAULT false,
  estimated_rows   bigint,
  exact_rows       bigint,
  exact_rows_at    timestamptz,
  table_bytes      bigint,
  index_bytes      bigint,
  total_bytes      bigint,
  dead_tuples      bigint,
  last_autovacuum  timestamptz,
  date_candidates  text[] NOT NULL DEFAULT '{}',
  insertion_column text,
  growth           jsonb,        -- latest six-month growth result (see worker/health/growth.ts)
  indexes          jsonb NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (application_id, schema_name, table_name)
);
COMMENT ON TABLE discovered_tables IS 'Tables found by automatic schema discovery, with their latest statistics. Presence here never makes a table archivable.';

CREATE TABLE table_columns (
  application_id text NOT NULL,
  schema_name    text NOT NULL,
  table_name     text NOT NULL,
  column_name    text NOT NULL,
  ordinal        integer NOT NULL,
  data_type      text NOT NULL,
  is_nullable    boolean NOT NULL,
  default_expr   text,
  is_date_candidate boolean NOT NULL DEFAULT false,
  PRIMARY KEY (application_id, schema_name, table_name, column_name),
  FOREIGN KEY (application_id, schema_name, table_name) REFERENCES discovered_tables ON DELETE CASCADE
);
COMMENT ON TABLE table_columns IS 'Discovered columns (type, nullability, default, date/timestamp candidacy). Used to validate policy date columns.';

CREATE TABLE foreign_keys (
  application_id  text NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  constraint_name text NOT NULL,
  child_table     text NOT NULL,    -- schema-qualified
  child_columns   text[] NOT NULL,
  parent_table    text NOT NULL,
  parent_columns  text[] NOT NULL,
  on_delete       text NOT NULL CHECK (on_delete IN ('NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL', 'SET DEFAULT')),
  discovered_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (application_id, child_table, constraint_name)
);
COMMENT ON TABLE foreign_keys IS 'The actual FK dependency graph as discovered from pg_constraint. Group validation and deletion order derive from it.';

CREATE TABLE table_stats_snapshots (
  application_id text NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  schema_name    text NOT NULL,
  table_name     text NOT NULL,
  captured_on    date NOT NULL,
  captured_at    timestamptz NOT NULL DEFAULT now(),
  estimated_rows bigint,
  exact_rows     bigint,
  total_bytes    bigint,
  index_bytes    bigint,
  dead_tuples    bigint,
  PRIMARY KEY (application_id, schema_name, table_name, captured_on)
);
COMMENT ON TABLE table_stats_snapshots IS 'One statistics snapshot per table per day. Builds the history for snapshot-based net growth; nothing is inferred before history exists.';

CREATE TABLE database_stats_snapshots (
  application_id text NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  captured_on    date NOT NULL,
  captured_at    timestamptz NOT NULL DEFAULT now(),
  database_bytes bigint NOT NULL,
  PRIMARY KEY (application_id, captured_on)
);
COMMENT ON TABLE database_stats_snapshots IS 'Daily database size per application (pg_database_size). DELETE does not shrink this immediately (Phase 3A P10).';

-- ---------------------------------------------------------------- retention
CREATE TABLE retention_policies (
  application_id  text NOT NULL,
  schema_name     text NOT NULL,
  table_name      text NOT NULL,
  policy          text NOT NULL DEFAULT 'REVIEW_REQUIRED' CHECK (policy IN ('REVIEW_REQUIRED', 'DO_NOT_ARCHIVE', 'ARCHIVE')),
  date_column     text,
  protected_period_months integer CHECK (protected_period_months >= 1),
  target_records  integer CHECK (target_records >= 1),
  grace_period_days integer CHECK (grace_period_days >= 0),   -- NULL → system default; no hard-coded value
  archive_format  text NOT NULL DEFAULT 'csv.gz' CHECK (archive_format IN ('csv.gz')),
  time_zone       text,                                       -- NULL → application time zone
  enabled         boolean NOT NULL DEFAULT false,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'incomplete', 'invalid')),
  group_root      text,                                       -- root table when archived as part of an FK group
  updated_by      text NOT NULL DEFAULT 'system:discovery',
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (application_id, schema_name, table_name),
  FOREIGN KEY (application_id, schema_name, table_name) REFERENCES discovered_tables ON DELETE CASCADE,
  CONSTRAINT only_archive_can_be_enabled CHECK (NOT enabled OR policy = 'ARCHIVE'),
  -- A group ROOT defines the day, protected period and target; a group MEMBER (child) follows its root's day via the FK.
  CONSTRAINT enabled_archive_is_complete CHECK (NOT enabled OR (group_root IS NOT NULL AND group_root <> schema_name || '.' || table_name)
                                                OR (date_column IS NOT NULL AND protected_period_months IS NOT NULL AND target_records IS NOT NULL))
);
COMMENT ON TABLE retention_policies IS 'Operator retention decisions. Every newly discovered table gets REVIEW_REQUIRED; only complete, enabled ARCHIVE policies may be planned.';

CREATE TABLE candidate_previews (
  application_id text NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  group_root     text NOT NULL,
  computed_at    timestamptz NOT NULL DEFAULT now(),
  status         text NOT NULL CHECK (status IN ('ready', 'target_not_reached', 'no_eligible_rows', 'blocked')),
  preview        jsonb NOT NULL,
  PRIMARY KEY (application_id, group_root)
);
COMMENT ON TABLE candidate_previews IS 'Latest READ-ONLY candidate preview per group (computed in a read-only snapshot; creates no job, freezes nothing).';

-- ---------------------------------------------------------------- jobs
CREATE TABLE archive_jobs (
  id              text PRIMARY KEY,
  application_id  text NOT NULL REFERENCES applications(id),
  group_root      text NOT NULL,
  tables          text[] NOT NULL,
  mode            text NOT NULL DEFAULT 'ARCHIVE_AND_VERIFY_ONLY' CHECK (mode IN ('ARCHIVE_AND_VERIFY_ONLY', 'ARCHIVE_VERIFY_DELETE')),
  status          text NOT NULL DEFAULT 'queued' CHECK (status IN (
                    'queued', 'preparing', 'freezing', 'exporting', 'verifying', 'ready_for_deletion',
                    'deletion_approved', 'deleting', 'verifying_deletion', 'waiting_retry',
                    'completed', 'completed_with_exceptions', 'failed', 'cancelled', 'requires_review')),
  resume_status   text,                          -- status to resume after waiting_retry
  attempt         integer NOT NULL DEFAULT 0,    -- export attempt
  retry_count     integer NOT NULL DEFAULT 0,
  next_retry_at   timestamptz,
  spec            jsonb NOT NULL,
  selection       jsonb,
  schema_hash     text,
  graph_hash      text,
  approved_by     text,
  approved_at     timestamptz,
  created_by      text NOT NULL,
  failure         jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz
);
-- one active job per (application, dependency group) — Phase 3A P7
CREATE UNIQUE INDEX archive_jobs_one_active_per_group ON archive_jobs (application_id, group_root)
  WHERE status NOT IN ('completed', 'completed_with_exceptions', 'failed', 'cancelled', 'requires_review');
COMMENT ON TABLE archive_jobs IS 'Archive jobs and their state machine. Unique partial index enforces one active job per application dependency group.';

CREATE TABLE archive_job_tables (
  job_id          text NOT NULL REFERENCES archive_jobs(id) ON DELETE CASCADE,
  table_name      text NOT NULL,
  role            text NOT NULL CHECK (role IN ('root', 'child')),
  parent_table    text,
  parent_fk_column text,
  delete_order    integer,
  candidate_rows  integer,
  deleted         integer NOT NULL DEFAULT 0,
  skipped         integer NOT NULL DEFAULT 0,   -- drifted or still referenced → never deleted
  missing         integer NOT NULL DEFAULT 0,   -- already gone when deletion ran
  reconciled      boolean,
  PRIMARY KEY (job_id, table_name)
);
COMMENT ON TABLE archive_job_tables IS 'Per-table membership, role and reconciliation counts of each job.';

CREATE TABLE archive_job_candidates (
  job_id      text NOT NULL REFERENCES archive_jobs(id) ON DELETE CASCADE,
  attempt     integer NOT NULL,
  table_name  text NOT NULL,
  chunk_no    integer NOT NULL,
  row_count   integer NOT NULL,
  pks         text[] NOT NULL,
  fingerprints text[] NOT NULL,
  parent_keys text[],
  chunk_sha256 text NOT NULL,
  PRIMARY KEY (job_id, attempt, table_name, chunk_no),
  CHECK (cardinality(pks) = row_count AND cardinality(fingerprints) = row_count)
);
COMMENT ON TABLE archive_job_candidates IS 'The exact frozen candidate identity (PK + row fingerprint) in chunks. This — never a date range — is the delete identity. Purgeable after a job finishes.';

CREATE TABLE archive_manifests (
  job_id          text NOT NULL REFERENCES archive_jobs(id) ON DELETE CASCADE,
  attempt         integer NOT NULL,
  store_kind      text NOT NULL,
  store_uri       text NOT NULL,
  manifest_key    text NOT NULL,
  manifest_sha256 text NOT NULL,
  manifest        jsonb NOT NULL,
  files           jsonb NOT NULL,        -- key → {bytes, sha256, rawSha256} recorded at upload time
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, attempt)
);
COMMENT ON TABLE archive_manifests IS 'Authoritative checksums and manifest of every export attempt, recorded at upload time. Verification compares the stored archive against THIS record.';

CREATE TABLE archive_verifications (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id          text NOT NULL REFERENCES archive_jobs(id) ON DELETE CASCADE,
  attempt         integer NOT NULL,
  verified        boolean NOT NULL,
  failed_stage    text,
  checks          jsonb NOT NULL,
  verifier_version text NOT NULL,
  duration_ms     integer,
  verified_at     timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE archive_verifications IS 'Every verification-gate run (all stages and checks). Deletion requires the latest run for the current attempt to be verified and fresh.';

CREATE TABLE archive_deletion_batches (
  job_id      text NOT NULL REFERENCES archive_jobs(id) ON DELETE CASCADE,
  batch_no    integer NOT NULL,
  state       text NOT NULL CHECK (state IN ('started', 'done')),
  requested   integer NOT NULL,
  deleted     integer,
  skipped     integer,
  missing     integer,
  per_table   jsonb,
  attempts    integer NOT NULL DEFAULT 1,
  started_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  PRIMARY KEY (job_id, batch_no)
);
COMMENT ON TABLE archive_deletion_batches IS 'Deletion checkpoints: a batch is marked started before its transaction and done after commit, making resume idempotent.';

-- ---------------------------------------------------------------- alerts / audit / coordination
CREATE TABLE alerts (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  application_id text NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  kind           text NOT NULL CHECK (kind IN ('table_records', 'database_capacity')),
  schema_name    text,
  table_name     text,
  level          text NOT NULL CHECK (level IN ('LOW', 'MEDIUM', 'HIGH')),
  state          text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'resolved')),
  observed_value bigint NOT NULL,
  threshold      bigint NOT NULL,
  avg_daily_growth numeric,
  escalated_from text,
  detected_at    timestamptz NOT NULL DEFAULT now(),
  resolved_at    timestamptz,
  notification   jsonb NOT NULL DEFAULT '{"whatsapp": "disabled", "email": "disabled"}'::jsonb
);
CREATE UNIQUE INDEX alerts_one_active ON alerts (application_id, kind, coalesce(schema_name, ''), coalesce(table_name, '')) WHERE state = 'active';
COMMENT ON TABLE alerts IS 'Threshold/capacity alerts with escalation and recovery. Notification delivery is DISABLED in Phase 3B.';

CREATE TABLE audit_logs (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at             timestamptz NOT NULL DEFAULT clock_timestamp(),
  application_id text,
  job_id         text,
  action         text NOT NULL,
  table_name     text,
  actor_type     text NOT NULL CHECK (actor_type IN ('user', 'system', 'worker')),
  actor_name     text NOT NULL,
  result         text NOT NULL CHECK (result IN ('success', 'failure', 'blocked', 'simulated', 'info')),
  detail         jsonb
);
CREATE INDEX audit_logs_app_at ON audit_logs (application_id, at DESC);
CREATE INDEX audit_logs_job ON audit_logs (job_id);
COMMENT ON TABLE audit_logs IS 'Append-only audit trail of every selection, freeze, export, verification, deletion attempt/block/completion, retry, failure and operator action.';

CREATE FUNCTION audit_logs_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only (% refused)', TG_OP;
END $$;
CREATE TRIGGER audit_logs_no_update BEFORE UPDATE OR DELETE ON audit_logs FOR EACH ROW EXECUTE FUNCTION audit_logs_append_only();
CREATE TRIGGER audit_logs_no_truncate BEFORE TRUNCATE ON audit_logs FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_append_only();

CREATE TABLE worker_leases (
  resource     text PRIMARY KEY,           -- e.g. job:<id>
  owner        text NOT NULL,
  acquired_at  timestamptz NOT NULL DEFAULT now(),
  heartbeat_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL
);
COMMENT ON TABLE worker_leases IS 'Leases with heartbeat: exactly one worker may act on a resource; an expired lease can be taken over (crash recovery).';

CREATE TABLE system_settings (
  id                          integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  record_threshold_low        bigint NOT NULL DEFAULT 1000000,   -- 10 lakh
  record_threshold_medium     bigint NOT NULL DEFAULT 1100000,   -- 11 lakh
  record_threshold_high       bigint NOT NULL DEFAULT 1200000,   -- 12 lakh
  capacity_threshold_low_pct  numeric,                           -- NOT FINAL — business values unconfirmed
  capacity_threshold_medium_pct numeric,
  capacity_threshold_high_pct numeric,
  capacity_thresholds_final   boolean NOT NULL DEFAULT false,
  default_archive_target      integer NOT NULL DEFAULT 125000,
  default_grace_period_days   integer CHECK (default_grace_period_days >= 0),  -- NULL until decided (no hard-coded value)
  deletion_batch_size         integer NOT NULL DEFAULT 2000 CHECK (deletion_batch_size BETWEEN 1 AND 5000),
  deletion_kill_switch        boolean NOT NULL DEFAULT true,     -- ON: deletion blocked
  verification_max_age_minutes integer NOT NULL DEFAULT 1440,
  whatsapp_destination        text,
  notifications_enabled       boolean NOT NULL DEFAULT false CHECK (notifications_enabled = false),  -- Phase 3B: must stay off
  scheduling_enabled          boolean NOT NULL DEFAULT false CHECK (scheduling_enabled = false),        -- Phase 3B: must stay off
  updated_by                  text NOT NULL DEFAULT 'system',
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  CHECK (record_threshold_low < record_threshold_medium AND record_threshold_medium < record_threshold_high)
);
INSERT INTO system_settings (id, capacity_threshold_low_pct, capacity_threshold_medium_pct, capacity_threshold_high_pct)
VALUES (1, 70, 80, 90);  -- demo values from Phase 1, flagged NOT FINAL via capacity_thresholds_final = false
COMMENT ON TABLE system_settings IS 'Singleton settings. Record thresholds 10L/11L/12L; capacity thresholds NOT FINAL; kill switch ON by default; notifications and scheduling constrained OFF.';
