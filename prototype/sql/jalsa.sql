-- PROTOTYPE / SYNTHETIC DATA ONLY — Jalsa-like schema. No real customers, all values generated.
SELECT setseed(0.1717);

CREATE TABLE public.orders (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_no    text NOT NULL UNIQUE,
  order_date  timestamptz NOT NULL,
  customer_ref text,                               -- synthetic token, not a person
  total       numeric(12,2) NOT NULL,
  status      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz
);
CREATE INDEX orders_order_date_idx ON public.orders (order_date);
CREATE TABLE public.order_items (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id   bigint NOT NULL REFERENCES public.orders(id),                 -- NO ACTION
  item_name  text NOT NULL,
  qty        integer NOT NULL,
  unit_price numeric(10,2) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX order_items_order_id_idx ON public.order_items (order_id);
CREATE TABLE public.payments (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id   bigint NOT NULL REFERENCES public.orders(id) ON DELETE RESTRICT,
  amount     numeric(12,2) NOT NULL,
  method     text NOT NULL,
  paid_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payments_order_id_idx ON public.payments (order_id);
CREATE TABLE public.audit_logs (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity     text NOT NULL,
  entity_id  bigint,
  action     text NOT NULL,
  payload    jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_created_at_idx ON public.audit_logs (created_at);

-- 250,000 orders 2024-01-01 .. 2026-09-28
INSERT INTO public.orders (order_no, order_date, customer_ref, total, status, created_at, updated_at)
SELECT 'J' || lpad(g::text, 8, '0'), od, 'CUST-' || (g % 9000),
       round((150 + (g % 2400) + random())::numeric, 2),
       (ARRAY['served','paid','cancelled'])[1 + (g % 20 = 0)::int + (g % 50 = 0)::int],
       CASE WHEN g % 250 = 3 THEN od + interval '45 days' ELSE od END,                -- 0.4% backfilled
       CASE WHEN g % 60 = 5 THEN od + interval '2 days' END
FROM (SELECT g, timestamptz '2024-01-01 11:00+05:30'
                + floor(1001 * sqrt(random())) * interval '1 day'
                + (g % 660) * interval '1 minute' AS od
      FROM generate_series(1, 250000) g) s;

-- ~3 items per order, names include Unicode (Hindi, Tamil, emoji)
INSERT INTO public.order_items (order_id, item_name, qty, unit_price, created_at)
SELECT o.id,
       (ARRAY['Paneer Tikka','पनीर टिक्का','மசாலா தோசை','Filter Coffee ☕','Veg Biryani'])[1 + ((o.id + k) % 5)],
       1 + ((o.id + k) % 3), round((40 + ((o.id * k) % 400) + 0.5)::numeric, 2),
       o.order_date + k * interval '3 minutes'                                 -- items may cross midnight
FROM public.orders o, generate_series(1, 3) k;

INSERT INTO public.payments (order_id, amount, method, paid_at, created_at)
SELECT id, total, (ARRAY['upi','card','cash'])[1 + id % 3],
       CASE WHEN status = 'cancelled' THEN NULL ELSE order_date + interval '40 minutes' END,
       order_date + interval '40 minutes'
FROM public.orders;

INSERT INTO public.audit_logs (entity, entity_id, action, payload, created_at)
SELECT 'order', g, (ARRAY['create','serve','pay'])[1 + g % 3],
       jsonb_build_object('seq', g, 'source', 'synthetic', 'note', repeat('x', g % 200)),
       timestamptz '2024-01-01 00:00+05:30' + floor(1001 * sqrt(random())) * interval '1 day' + (g % 86400) * interval '1 second'
FROM generate_series(1, 250000) g;

ANALYZE;
