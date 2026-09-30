-- PROTOTYPE / SYNTHETIC DATA ONLY — RosiFit-like schema. No real people, all values generated.
SELECT setseed(0.4242);

CREATE TABLE public.members (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  member_code text NOT NULL UNIQUE,
  display_name text NOT NULL,
  joined_on   date NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.courses (
  id    integer PRIMARY KEY,
  title text NOT NULL
);
CREATE TABLE public.attendance_records (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  member_id       bigint NOT NULL REFERENCES public.members(id),            -- NO ACTION
  course_id       integer NOT NULL REFERENCES public.courses(id),           -- NO ACTION
  attendance_date date,                                                     -- NULL allowed (1% synthetic)
  checked_in_at   timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz,
  note            text
);
CREATE INDEX attendance_records_attendance_date_idx ON public.attendance_records (attendance_date);
CREATE TABLE public.audit_logs (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity     text NOT NULL,
  entity_id  bigint,
  action     text NOT NULL,
  payload    jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_created_at_idx ON public.audit_logs (created_at);
CREATE TABLE public.notifications (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  member_id  bigint NOT NULL REFERENCES public.members(id) ON DELETE CASCADE,
  channel    text NOT NULL,
  body       text NOT NULL,
  sent_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_created_at_idx ON public.notifications (created_at);

INSERT INTO public.courses (id, title)
SELECT g, 'Synthetic course ' || g FROM generate_series(1, 40) g;

INSERT INTO public.members (member_code, display_name, joined_on, created_at)
SELECT 'M' || lpad(g::text, 6, '0'), 'Synthetic Member ' || g,
       date '2022-06-01' + (g % 1500), timestamptz '2022-06-01 00:00+05:30' + (g % 1500) * interval '1 day'
FROM generate_series(1, 2000) g;

-- 1,000,000 attendance rows, 2023-01-01 .. 2026-09-28, skewed towards recent dates.
INSERT INTO public.attendance_records (member_id, course_id, attendance_date, checked_in_at, created_at, updated_at, note)
SELECT 1 + (g % 2000),
       1 + (g % 40),
       CASE WHEN g % 100 = 0 THEN NULL ELSE d END,                                   -- 1% NULL dates
       (d + time '06:00' + (g % 720) * interval '1 minute') AT TIME ZONE 'Asia/Kolkata',
       CASE WHEN g % 200 = 1                                                          -- 0.5% backdated
            THEN (d + 20 + (g % 180)) + time '10:00'
            ELSE (d + time '06:00' + (g % 720) * interval '1 minute') END AT TIME ZONE 'Asia/Kolkata',
       CASE WHEN g % 50 = 7 THEN (d + 3) + time '09:00' END AT TIME ZONE 'Asia/Kolkata', -- 2% edited
       CASE WHEN g % 10 = 0 THEN 'Synthetic note ' || g END
FROM (
  SELECT g, date '2023-01-01' + floor(1366 * sqrt(random()))::int AS d
  FROM generate_series(1, 1000000) g
) s;

INSERT INTO public.audit_logs (entity, entity_id, action, payload, created_at)
SELECT 'attendance', g, (ARRAY['create','update','checkin'])[1 + g % 3],
       jsonb_build_object('seq', g, 'source', 'synthetic'),
       timestamptz '2023-01-01 00:00+05:30' + floor(1366 * sqrt(random())) * interval '1 day' + (g % 86400) * interval '1 second'
FROM generate_series(1, 200000) g;

INSERT INTO public.notifications (member_id, channel, body, sent_at, created_at)
SELECT 1 + (g % 2000), (ARRAY['app','sms'])[1 + g % 2], 'Synthetic reminder #' || g,
       CASE WHEN g % 40 = 0 THEN NULL ELSE c + interval '5 minutes' END, c
FROM (SELECT g, timestamptz '2023-01-01 00:00+05:30' + floor(1366 * sqrt(random())) * interval '1 day' AS c
      FROM generate_series(1, 150000) g) s;

ANALYZE;
