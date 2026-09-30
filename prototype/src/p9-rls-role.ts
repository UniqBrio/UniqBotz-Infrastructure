/**
 * PROTOTYPE / SYNTHETIC DATA ONLY — P9 Least-privilege archiver role + RLS (ADR §16.2, P-6).
 * Runs on the official Supabase Postgres image locally (postgres = non-superuser with CREATEROLE/BYPASSRLS,
 * as on hosted Supabase). Hosted-platform behaviour still needs confirmation on a real project.
 */
import { DBS, connect } from "./lib/db.ts";
import { exportGroup } from "./lib/archive.ts";
import { buildContext, deleteBatch, expandBatch, rootBatches } from "./lib/deleter.ts";
import { planGroup, selectCandidate } from "./lib/group.ts";
import { Recorder } from "./lib/results.ts";

const rec = new Recorder("p9-rls-role", "P9 — RLS / archiver role");
const owner = await connect(DBS.rosifit);
const PW = "archiver-local-only";
const code = async (p: Promise<unknown>) => { try { await p; return "ok"; } catch (e) { return (e as { code?: string }).code ?? String(e); } };

await owner.query(`DROP TABLE IF EXISTS public.rls_lab`);
await owner.query(`CREATE TABLE public.rls_lab AS SELECT * FROM public.attendance_records WHERE attendance_date IS NOT NULL ORDER BY attendance_date, id LIMIT 20000`);
await owner.query(`ALTER TABLE public.rls_lab ADD PRIMARY KEY (id); CREATE INDEX ON public.rls_lab (attendance_date); ANALYZE public.rls_lab`);
for (const r of ["uniqbotz_archiver", "uniqbotz_archiver_bypass"]) {
  await owner.query(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${r}') THEN
     EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${r}'; EXECUTE 'REVOKE ALL ON SCHEMA public FROM ${r}';
     EXECUTE 'REVOKE ALL ON DATABASE ${DBS.rosifit} FROM ${r}'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$`);
}
// least-privilege login role
rec.check("postgres (non-superuser) can create a LOGIN role", "ok",
  await code(owner.query(`CREATE ROLE uniqbotz_archiver LOGIN PASSWORD '${PW}' NOINHERIT CONNECTION LIMIT 2`)));
await owner.query(`ALTER ROLE uniqbotz_archiver SET statement_timeout = '10min'`);
await owner.query(`ALTER ROLE uniqbotz_archiver SET lock_timeout = '2s'`);
await owner.query(`GRANT CONNECT ON DATABASE ${DBS.rosifit} TO uniqbotz_archiver`);
await owner.query(`GRANT USAGE ON SCHEMA public TO uniqbotz_archiver`);
await owner.query(`GRANT SELECT, DELETE ON public.rls_lab TO uniqbotz_archiver`);

const arch = await connect(DBS.rosifit, { user: "uniqbotz_archiver", password: PW });
const settings = (await arch.query(`SELECT current_setting('statement_timeout') st, current_setting('lock_timeout') lt`)).rows[0];
rec.check("role-level timeouts apply on login", { st: "10min", lt: "2s" }, settings);
const trueCount = Number((await owner.query(`SELECT count(*) n FROM public.rls_lab`)).rows[0].n);
rec.check("SELECT visibility without RLS = full table", trueCount, Number((await arch.query(`SELECT count(*) n FROM public.rls_lab`)).rows[0].n));
rec.check("INSERT denied", "42501", await code(arch.query(`INSERT INTO public.rls_lab (id, member_id, course_id, created_at) VALUES (-1, 1, 1, now())`)));
rec.check("UPDATE denied", "42501", await code(arch.query(`UPDATE public.rls_lab SET note = 'x' WHERE id = (SELECT min(id) FROM public.rls_lab)`)));
rec.check("TRUNCATE denied", "42501", await code(arch.query(`TRUNCATE public.rls_lab`)));
rec.check("DDL denied (ALTER TABLE)", "42501", await code(arch.query(`ALTER TABLE public.rls_lab ADD COLUMN x int`)));
rec.check("unrelated table: SELECT denied", "42501", await code(arch.query(`SELECT 1 FROM public.members LIMIT 1`)));
rec.check("unrelated table: DELETE denied", "42501", await code(arch.query(`DELETE FROM public.members WHERE id = -1`)));
const authExists = (await owner.query(`SELECT to_regclass('auth.users') IS NOT NULL e`)).rows[0].e;
rec.measure("auth_schema_present_in_image", authExists);
if (authExists) rec.check("application metadata (auth.users) denied", "42501", await code(arch.query(`SELECT 1 FROM auth.users LIMIT 1`)));
rec.check("cannot create roles or escalate", "42501", await code(arch.query(`CREATE ROLE x`)));
rec.check("catalog introspection (planning) works as archiver", [], (await planGroup(arch, { applicationId: "r", database: DBS.rosifit, root: "public.rls_lab", dateColumn: "attendance_date", tables: ["public.rls_lab"], timeZone: "Asia/Kolkata", cutoffDay: "2025-09-30", target: 1000 })).blocking);

// exact delete works with SELECT+DELETE only (fingerprint needs SELECT on all columns)
const planA = await planGroup(arch, { applicationId: "r", database: DBS.rosifit, root: "public.rls_lab", dateColumn: "attendance_date", tables: ["public.rls_lab"], timeZone: "Asia/Kolkata", cutoffDay: "2025-09-30", target: 1000 });
const selA = await selectCandidate(arch, planA);
const exA = await exportGroup(arch, planA, selA, "P9-archiver", 1);
const ctxA = await buildContext(exA.dir, exA.manifest, planA.schemas, planA.edges);
let delA = 0;
for (const b of rootBatches(ctxA, 500)) delA += (await deleteBatch(arch, ctxA, expandBatch(ctxA, b)))["public.rls_lab"]!.deleted;
rec.check("archiver can export and exact-delete with only SELECT + DELETE", selA.totalSelected, delA);

// ---- RLS: partial visibility ----
await owner.query(`ALTER TABLE public.rls_lab ENABLE ROW LEVEL SECURITY`);
await owner.query(`CREATE POLICY even_members ON public.rls_lab FOR ALL TO PUBLIC USING (member_id % 2 = 0)`);
const real = Number((await owner.query(`SELECT count(*) n FROM public.rls_lab`)).rows[0].n); // postgres has BYPASSRLS
const seen = Number((await arch.query(`SELECT count(*) n FROM public.rls_lab`)).rows[0].n);
const est = Number((await arch.query(`SELECT reltuples::bigint n FROM pg_class WHERE oid = 'public.rls_lab'::regclass`)).rows[0].n);
rec.measure("rls_partial_visibility", { trueRows: real, archiverSees: seen, catalogEstimateVisibleToArchiver: est });
rec.check("RLS silently hides rows from the archiver (no error)", true, seen < real && seen > 0);
const planRls = await planGroup(arch, { applicationId: "r", database: DBS.rosifit, root: "public.rls_lab", dateColumn: "attendance_date", tables: ["public.rls_lab"], timeZone: "Asia/Kolkata", cutoffDay: "2025-09-30", target: 1000 });
rec.check("preflight blocks the job: RLS enabled and role does not bypass it", true, planRls.blocking.some((b) => b.startsWith("rls_enabled")));

// what would happen WITHOUT the preflight: the archiver's own reconciliation is blind too
const selRls = await selectCandidate(arch, planRls);
const trueInRange = Number((await owner.query(`SELECT count(*) n FROM public.rls_lab WHERE attendance_date <= $1::date`, [selRls.boundaryDate])).rows[0].n);
const seenInRange = Number((await arch.query(`SELECT count(*) n FROM public.rls_lab WHERE attendance_date <= $1::date`, [selRls.boundaryDate])).rows[0].n);
rec.measure("rls_candidate_undercount", { selectedByArchiver: selRls.totalSelected, trueRowsInSameDays: trueInRange, archiverSeesInSameDays: seenInRange });
rec.check("without preflight the candidate would silently omit hidden rows (whole days no longer whole)", true, trueInRange > selRls.totalSelected);

// default-deny RLS (no policy for this role) → 0 rows
await owner.query(`DROP POLICY even_members ON public.rls_lab`);
await owner.query(`CREATE POLICY app_users_only ON public.rls_lab FOR ALL TO authenticated USING (true)`);
rec.check("RLS with policies only for app roles → archiver sees 0 rows", 0, Number((await arch.query(`SELECT count(*) n FROM public.rls_lab`)).rows[0].n));

// BYPASSRLS as a mitigation
const bypassCreate = await code(owner.query(`CREATE ROLE uniqbotz_archiver_bypass LOGIN PASSWORD '${PW}' BYPASSRLS NOINHERIT CONNECTION LIMIT 2`));
rec.measure("create_role_with_BYPASSRLS_as_postgres", bypassCreate);
if (bypassCreate === "ok") {
  await owner.query(`GRANT CONNECT ON DATABASE ${DBS.rosifit} TO uniqbotz_archiver_bypass; GRANT USAGE ON SCHEMA public TO uniqbotz_archiver_bypass; GRANT SELECT, DELETE ON public.rls_lab TO uniqbotz_archiver_bypass`);
  const byp = await connect(DBS.rosifit, { user: "uniqbotz_archiver_bypass", password: PW });
  rec.check("BYPASSRLS archiver sees the full table under RLS", real, Number((await byp.query(`SELECT count(*) n FROM public.rls_lab`)).rows[0].n));
  rec.check("BYPASSRLS does not grant other privileges (still no UPDATE)", "42501", await code(byp.query(`UPDATE public.rls_lab SET note = 'x' WHERE id = (SELECT min(id) FROM public.rls_lab)`)));
  await byp.end();
}
await arch.end();
await owner.query(`DROP TABLE public.rls_lab`);
await owner.end();
rec.save();
