-- PROTOTYPE / SYNTHETIC DATA ONLY — minimal control-plane tables for the job runner prototype.
CREATE TABLE public.jobs (
  id               text PRIMARY KEY,
  application_id   text NOT NULL,
  table_group      text NOT NULL,
  status           text NOT NULL,
  attempt          integer NOT NULL DEFAULT 0,
  lease_owner      text,
  lease_expires_at timestamptz,
  spec             jsonb NOT NULL,
  selection        jsonb,
  manifest_sha256  text,
  manifest         jsonb,
  verification     jsonb,
  schema_hash      text,
  graph_hash       text,
  approved_by      text,
  counts           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
-- D-19: at most one active job per (application, table group)
CREATE UNIQUE INDEX jobs_one_active_per_group
  ON public.jobs (application_id, table_group)
  WHERE status NOT IN ('completed', 'completed_with_exceptions', 'failed', 'cancelled', 'requires_review');

CREATE TABLE public.job_batches (
  job_id      text NOT NULL REFERENCES public.jobs(id),
  table_name  text NOT NULL,
  batch_no    integer NOT NULL,
  requested   integer NOT NULL,
  deleted     integer,
  drifted     integer,
  missing     integer,
  state       text NOT NULL,                 -- started | done
  attempts    integer NOT NULL DEFAULT 1,
  started_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  PRIMARY KEY (job_id, table_name, batch_no)
);

CREATE TABLE public.job_events (
  id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id  text NOT NULL,
  at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  event   text NOT NULL,
  detail  jsonb
);

CREATE TABLE public.settings (
  id                   integer PRIMARY KEY CHECK (id = 1),
  deletion_kill_switch boolean NOT NULL DEFAULT false
);
INSERT INTO public.settings VALUES (1, false);
