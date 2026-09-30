#!/usr/bin/env tsx
/**
 * HOSTED SUPABASE VALIDATION — DISPOSABLE PROJECT + SYNTHETIC DATA ONLY.
 * See HOSTED_SUPABASE_VALIDATION_RUNBOOK.md. Runs the 16 checks and writes a JSON evidence file.
 *
 * Safety rails (all must pass before anything is created):
 *   - HV_PROJECT_REF is set and is NOT a known production project ref;
 *   - HV_CONFIRM_DISPOSABLE === `I-CONFIRM-${HV_PROJECT_REF}-IS-DISPOSABLE`;
 *   - the target database's public schema is EMPTY (or contains only this script's marker table): a database
 *     holding any other table is refused as possibly real;
 *   - every URL points at the same project (host contains the ref) unless HV_LOCAL_REHEARSAL=1 (127.0.0.1 only).
 * The script creates objects only inside that disposable database and drops its validation roles at the end.
 *
 * Env: HV_PROJECT_REF, HV_CONFIRM_DISPOSABLE, HV_OWNER_URL (direct, postgres role),
 *      HV_POOLER_SESSION_URL, HV_POOLER_TRANSACTION_URL (optional), HV_CA_CERT (path, for verify-full),
 *      HV_ROLE_PASSWORD (synthetic password for the validation roles), HV_RESULTS_DIR (default hosted-validation-results)
 */
import { lookup } from "node:dns/promises";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Writable } from "node:stream";
import pg from "pg";
import { to as copyTo } from "pg-copy-streams";
import { PINNED_SESSION_SQL } from "../connection/connect";
import { discoverDatabase } from "../discovery/catalog";
import { deleteBatch } from "../deletion/batch";
import { planGroup } from "../retention/group";
import { fingerprintSql } from "../schema/fingerprint";

/** Never validate against these. */
export const KNOWN_PRODUCTION_REFS = ["lhpzhkzbnquwjljmbylo"];

export interface CheckResult { id: number; name: string; status: "pass" | "fail" | "manual" | "skipped"; detail: string; ms?: number }

type Env = Record<string, string | undefined>;

export function assertDisposable(env: Env): { ref: string; local: boolean } {
  const ref = env.HV_PROJECT_REF ?? "";
  if (!/^[a-z0-9-]{3,40}$/.test(ref)) throw new Error("HV_PROJECT_REF is required");
  if (KNOWN_PRODUCTION_REFS.includes(ref)) throw new Error(`REFUSED: ${ref} is a known PRODUCTION project`);
  if (env.HV_CONFIRM_DISPOSABLE !== `I-CONFIRM-${ref}-IS-DISPOSABLE`) throw new Error(`REFUSED: set HV_CONFIRM_DISPOSABLE=I-CONFIRM-${ref}-IS-DISPOSABLE`);
  const local = env.HV_LOCAL_REHEARSAL === "1";
  for (const k of ["HV_OWNER_URL", "HV_POOLER_SESSION_URL", "HV_POOLER_TRANSACTION_URL"]) {
    const u = env[k];
    if (!u) continue;
    const host = new URL(u).hostname;
    if (local ? !["127.0.0.1", "localhost"].includes(host) : !(host.includes(ref) || new URL(u).username.includes(ref))) {
      throw new Error(`REFUSED: ${k} does not point at project ${ref}${local ? " (local rehearsal allows 127.0.0.1 only)" : ""}`);
    }
  }
  return { ref, local };
}

function ssl(env: Env, local: boolean) {
  if (local) return false;
  return env.HV_CA_CERT ? { rejectUnauthorized: true, ca: readFileSync(env.HV_CA_CERT, "utf8") } : { rejectUnauthorized: true };
}

async function connect(url: string, env: Env, local: boolean, extra: Partial<pg.ClientConfig> = {}) {
  const c = new pg.Client({ connectionString: url, ssl: ssl(env, local), connectionTimeoutMillis: 15_000, application_name: "uniqbotz-hosted-validation", ...extra });
  c.on("error", () => {});
  await c.connect();
  return c;
}

const SCHEMA = `
CREATE TABLE public.uniqbotz_validation_marker (created_at timestamptz NOT NULL DEFAULT now(), note text NOT NULL DEFAULT 'SYNTHETIC — disposable validation');
CREATE TABLE public.hv_parent (id bigint PRIMARY KEY, happened_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), note text);
CREATE TABLE public.hv_child (id bigint PRIMARY KEY, parent_id bigint NOT NULL REFERENCES public.hv_parent(id) ON DELETE CASCADE, body text);
CREATE INDEX ON public.hv_child (parent_id);
CREATE TABLE public.hv_rls (id bigint PRIMARY KEY, owner_id int NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE public.hv_rls ENABLE ROW LEVEL SECURITY;
CREATE POLICY hv_rls_owner ON public.hv_rls USING (owner_id = 1);
INSERT INTO public.uniqbotz_validation_marker DEFAULT VALUES;
INSERT INTO public.hv_parent SELECT g, timestamptz '2025-01-01' + make_interval(mins => g), timestamptz '2025-01-01' + make_interval(mins => g), 'synthetic' FROM generate_series(1, 50000) g;
INSERT INTO public.hv_child SELECT g, g, 'synthetic child' FROM generate_series(1, 50000) g WHERE g % 2 = 0;
INSERT INTO public.hv_rls SELECT g, 1 + g % 4 FROM generate_series(1, 2000) g;
ANALYZE;`;

async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const t0 = Date.now();
  const r = await fn();
  return [r, Date.now() - t0];
}

export async function runHostedValidation(env: Env = process.env): Promise<CheckResult[]> {
  const { ref, local } = assertDisposable(env);
  const pw = env.HV_ROLE_PASSWORD;
  if (!pw || pw.length < 16) throw new Error("HV_ROLE_PASSWORD (synthetic, ≥16 chars) is required for the validation roles");
  const results: CheckResult[] = [];
  const add = (id: number, name: string, status: CheckResult["status"], detail: string, ms?: number) => results.push({ id, name, status, detail, ms });
  const owner = await connect(env.HV_OWNER_URL!, env, local);
  const ownerUrl = new URL(env.HV_OWNER_URL!);
  const roleUrl = (user: string) => { const u = new URL(ownerUrl); u.username = user; u.password = pw; return u.toString(); };

  try {
    // Empty-database rail
    const tables = (await owner.query(`SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r'`)).rows.map((r) => r.relname as string);
    const ours = ["uniqbotz_validation_marker", "hv_parent", "hv_child", "hv_rls"];
    if (tables.some((t) => !ours.includes(t))) throw new Error(`REFUSED: public schema contains non-validation tables (${tables.filter((t) => !ours.includes(t)).join(", ")}) — not a disposable database`);
    if (tables.length && !tables.includes("uniqbotz_validation_marker")) throw new Error("REFUSED: validation tables present without the marker");
    if (!tables.length) await owner.query(SCHEMA);

    // 1. connection pooler
    for (const [label, key] of [["session", "HV_POOLER_SESSION_URL"], ["transaction", "HV_POOLER_TRANSACTION_URL"]] as const) {
      if (!env[key]) { add(1, `connection pooler (${label} mode)`, "skipped", `${key} not provided`); continue; }
      try {
        const c = await connect(env[key]!, env, local);
        const [snap, ms] = await timed(async () => {
          await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
          const a = (await c.query(`SELECT count(*) n FROM public.hv_parent`)).rows[0].n;
          const b = (await c.query(`SELECT count(*) n FROM public.hv_parent`)).rows[0].n;
          await c.query("COMMIT");
          await c.query(PINNED_SESSION_SQL);
          const tz = (await c.query(`SHOW TimeZone`)).rows[0].TimeZone;
          return { a, b, tz };
        });
        await c.end();
        add(1, `connection pooler (${label} mode)`, snap.a === snap.b && snap.tz === "UTC" ? "pass" : "fail",
          `RR READ ONLY snapshot counts ${snap.a}/${snap.b}; session SET TimeZone kept: ${snap.tz}${label === "transaction" ? " (transaction mode: SET only lasts per transaction — the worker must use session mode or direct)" : ""}`, ms);
      } catch (e) { add(1, `connection pooler (${label} mode)`, "fail", (e as Error).message); }
    }

    // 2. SSL certificate verification
    if (local) add(2, "SSL certificate verification", "skipped", "local rehearsal (no TLS)");
    else {
      const r = (await owner.query(`SELECT ssl, version, cipher FROM pg_stat_ssl WHERE pid = pg_backend_pid()`)).rows[0];
      add(2, "SSL certificate verification", r?.ssl ? "pass" : "fail", `rejectUnauthorized=true${env.HV_CA_CERT ? " with pinned CA" : " with system CAs"}; ${r?.version ?? "no ssl"} ${r?.cipher ?? ""}`);
    }

    // 3. IPv4 connectivity
    try {
      const a4 = await lookup(ownerUrl.hostname, { family: 4, all: true }).catch(() => []);
      add(3, "IPv4 connectivity", a4.length || local ? "pass" : "manual",
        a4.length ? `A records: ${a4.map((x) => x.address).join(", ")}` : "no IPv4 A record for the direct host — use the pooler (IPv4) or the IPv4 add-on; record which path the worker host uses");
    } catch (e) { add(3, "IPv4 connectivity", "fail", (e as Error).message); }

    // 4–7. custom roles, least privilege, RLS, BYPASSRLS
    for (const r of ["uniqbotz_hv_monitor", "uniqbotz_hv_archiver", "uniqbotz_hv_archiver_bypass"]) {
      await owner.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${r}`).catch(() => {});
      await owner.query(`REVOKE ALL ON SCHEMA public FROM ${r}`).catch(() => {});
      await owner.query(`DROP ROLE IF EXISTS ${r}`).catch(() => {});
    }
    try {
      await owner.query(`CREATE ROLE uniqbotz_hv_monitor LOGIN PASSWORD '${pw.replace(/'/g, "''")}' NOINHERIT CONNECTION LIMIT 2`);
      await owner.query(`CREATE ROLE uniqbotz_hv_archiver LOGIN PASSWORD '${pw.replace(/'/g, "''")}' NOINHERIT CONNECTION LIMIT 2`);
      await owner.query(`GRANT USAGE ON SCHEMA public TO uniqbotz_hv_monitor, uniqbotz_hv_archiver;
        GRANT SELECT ON ALL TABLES IN SCHEMA public TO uniqbotz_hv_monitor, uniqbotz_hv_archiver;
        GRANT DELETE ON public.hv_parent, public.hv_child, public.hv_rls TO uniqbotz_hv_archiver;
        ALTER ROLE uniqbotz_hv_archiver SET statement_timeout = '30s'; ALTER ROLE uniqbotz_hv_archiver SET lock_timeout = '2s';`);
      add(4, "custom role", "pass", "created LOGIN roles uniqbotz_hv_monitor / uniqbotz_hv_archiver with role-level timeouts");
    } catch (e) { add(4, "custom role", "fail", (e as Error).message); }

    let mon: pg.Client | null = null;
    let arc: pg.Client | null = null;
    try {
      mon = await connect(roleUrl("uniqbotz_hv_monitor"), env, local);
      arc = await connect(roleUrl("uniqbotz_hv_archiver"), env, local);
      const denied = async (c: pg.Client, sql: string) => c.query(sql).then(() => "ALLOWED", (e) => (e as { code?: string }).code ?? "error");
      const checks = {
        monitorInsert: await denied(mon, `INSERT INTO public.hv_parent VALUES (-1, now(), now(), 'x')`),
        archiverUpdate: await denied(arc, `UPDATE public.hv_parent SET note = 'x' WHERE id = 1`),
        archiverTruncate: await denied(arc, `TRUNCATE public.hv_child`),
        archiverDdl: await denied(arc, `CREATE TABLE public.hv_should_not_exist (id int)`),
        archiverCreateRole: await denied(arc, `CREATE ROLE hv_x`),
      };
      add(5, "least privilege", Object.values(checks).every((v) => v === "42501") ? "pass" : "fail", JSON.stringify(checks));
      const visible = Number((await arc.query(`SELECT count(*) n FROM public.hv_rls`)).rows[0].n);
      const real = Number((await owner.query(`SELECT count(*) n FROM public.hv_rls`)).rows[0].n);
      add(6, "RLS", visible < real ? "pass" : "fail", `non-bypass archiver sees ${visible} of ${real} rows (the worker must block such tables: rls_hides_rows)`);
      const plan = await planGroup(arc, { applicationId: "hv", root: "public.hv_rls", dateColumn: "created_at", tables: ["public.hv_rls"], timeZone: "UTC", cutoffDay: "2030-01-01", target: 10 });
      add(6, "RLS preflight blocks", plan.blocking.some((b) => b.startsWith("rls_hides_rows")) ? "pass" : "fail", plan.blocking.join("; ") || "not blocked");
    } catch (e) { add(5, "least privilege", "fail", (e as Error).message); }
    try {
      await owner.query(`CREATE ROLE uniqbotz_hv_archiver_bypass LOGIN PASSWORD '${pw.replace(/'/g, "''")}' BYPASSRLS NOINHERIT CONNECTION LIMIT 1`);
      await owner.query(`GRANT USAGE ON SCHEMA public TO uniqbotz_hv_archiver_bypass; GRANT SELECT ON public.hv_rls TO uniqbotz_hv_archiver_bypass`);
      const b = await connect(roleUrl("uniqbotz_hv_archiver_bypass"), env, local);
      const n = Number((await b.query(`SELECT count(*) n FROM public.hv_rls`)).rows[0].n);
      await b.end();
      add(7, "BYPASSRLS behavior", n === 2000 ? "pass" : "fail", `postgres could create a BYPASSRLS role; it sees ${n} of 2000 rows`);
    } catch (e) { add(7, "BYPASSRLS behavior", "manual", `could not create/use a BYPASSRLS role: ${(e as Error).message} — use RLS policies scoped to the archiver instead (ADR §16.2 option b)`); }

    // 8. schema introspection (as the monitor role)
    try {
      const [d, ms] = await timed(() => discoverDatabase(mon!));
      const fk = d.foreignKeys.find((e) => e.child === "public.hv_child");
      add(8, "schema introspection", d.tables.some((t) => t.qualified === "public.hv_parent") && fk?.onDelete === "CASCADE" ? "pass" : "fail",
        `${d.tables.length} tables, ${d.foreignKeys.length} FKs visible to the monitor role; insertion column hv_parent: ${d.tables.find((t) => t.qualified === "public.hv_parent")?.insertionColumn}`, ms);
    } catch (e) { add(8, "schema introspection", "fail", (e as Error).message); }

    // 9. exact row count
    const [n, countMs] = await timed(async () => Number((await mon!.query(`SELECT count(*) n FROM public.hv_parent`)).rows[0].n));
    add(9, "exact row count", n === 50000 ? "pass" : "fail", `50,000 synthetic rows counted`, countMs);

    // 10. snapshot behaviour: concurrent insert invisible inside RR READ ONLY
    {
      await arc!.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const before = Number((await arc!.query(`SELECT count(*) n FROM public.hv_parent`)).rows[0].n);
      await owner.query(`INSERT INTO public.hv_parent VALUES (900001, '2025-01-01', now(), 'late')`);
      const inside = Number((await arc!.query(`SELECT count(*) n FROM public.hv_parent`)).rows[0].n);
      await arc!.query("COMMIT");
      await owner.query(`DELETE FROM public.hv_parent WHERE id = 900001`);
      add(10, "snapshot behavior", before === inside ? "pass" : "fail", `count before ${before}, after concurrent insert inside snapshot ${inside}`);
    }

    // 11. export timing (COPY TO STDOUT of 50k rows)
    {
      let bytes = 0;
      const [, ms] = await timed(() => pipeline(arc!.query(copyTo(`COPY (SELECT * FROM public.hv_parent) TO STDOUT WITH (FORMAT csv, HEADER)`)),
        new Writable({ write(chunk, _e, cb) { bytes += chunk.length; cb(); } })));
      add(11, "export timing", "pass", `50,000 rows, ${bytes} bytes CSV`, ms);
    }

    // 12. delete batch timing (2,000 exact keys + fingerprints; synthetic)
    try {
      await arc!.query(PINNED_SESSION_SQL);
      const keys = (await arc!.query(`SELECT t.id::text pk, ${fingerprintSql("t")} fp FROM public.hv_parent t WHERE t.id % 2 = 1 ORDER BY id LIMIT 2000`)).rows.map((r) => ({ pk: r.pk, fp: r.fp, parentKey: null }));
      const plan = await planGroup(arc!, { applicationId: "hv", root: "public.hv_parent", dateColumn: "happened_at", tables: ["public.hv_parent", "public.hv_child"], timeZone: "UTC", cutoffDay: "2030-01-01", target: 1 });
      const [out, ms] = await timed(() => deleteBatch(arc!, { deleteOrder: plan.deleteOrder, schemas: plan.schemas, edges: plan.edges, lockTimeoutMs: 2000, statementTimeoutMs: 30000 }, { "public.hv_parent": keys, "public.hv_child": [] }));
      add(12, "delete batch timing", out["public.hv_parent"]!.deleted === 2000 ? "pass" : "fail", `2,000 exact-key rows (synthetic) → ${JSON.stringify(out["public.hv_parent"])}`, ms);
    } catch (e) { add(12, "delete batch timing", "fail", (e as Error).message); }

    // 13. locks: lock_timeout fires while another session holds a row lock
    {
      const holder = await connect(env.HV_OWNER_URL!, env, local);
      await holder.query("BEGIN");
      await holder.query(`SELECT * FROM public.hv_parent WHERE id = 2 FOR UPDATE`);
      const t0 = Date.now();
      const code = await arc!.query(`BEGIN; SET LOCAL lock_timeout = '1s'; DELETE FROM public.hv_parent WHERE id = 2; COMMIT;`).then(() => "no-timeout", (e) => (e as { code?: string }).code);
      await arc!.query("ROLLBACK").catch(() => {});
      await holder.query("ROLLBACK");
      await holder.end();
      add(13, "locks", code === "55P03" ? "pass" : "fail", `lock_timeout → ${code} after ${Date.now() - t0} ms (worker classifies 55P03 as retryable)`);
    }

    // 14. read-only mode
    {
      // Use a role that COULD write (owner) so the refusal comes from read-only mode, not from missing privileges.
      const ro = await connect(env.HV_OWNER_URL!, env, local);
      // Separate statements: a SET inside the same multi-statement string does not affect the implicit transaction already running.
      await ro.query(`SET default_transaction_read_only = on`);
      const code = await ro.query(`INSERT INTO public.uniqbotz_validation_marker DEFAULT VALUES`).then(() => "ALLOWED", (e) => (e as { code?: string }).code);
      await ro.end();
      add(14, "read-only mode (session)", code === "25006" ? "pass" : "fail", `write attempt by a write-capable role in a read-only session → ${code} (expected 25006)`);
      add(14, "read-only mode (Free-plan disk-full)", "manual", "Supabase switches a full Free-plan database to read-only; record the observed error code (expected 25006) and that the worker classifies it as read_only (never auto-escaped). Do NOT fill a shared project to test this.");
    }

    // 15. database size
    {
      const r = (await mon!.query(`SELECT pg_database_size(current_database()) AS b`)).rows[0];
      add(15, "database size", "manual", `pg_database_size = ${r.b} bytes (${(Number(r.b) / 1048576).toFixed(1)} MB) — compare with the dashboard's reported size and the plan quota`);
    }

    // 16. statistics visibility
    {
      await owner.query(`SELECT pg_stat_force_next_flush()`).catch(() => {});
      const r = (await mon!.query(`SELECT relname, n_live_tup, n_dead_tup, last_autovacuum, last_analyze, pg_total_relation_size(relid) AS bytes FROM pg_stat_user_tables WHERE relname IN ('hv_parent','hv_child') ORDER BY 1`)).rows;
      // Pass = the monitor role can SEE the statistics rows and sizes; counter freshness depends on the stats flush interval.
      add(16, "statistics visibility", r.length === 2 && r.every((x) => Number(x.bytes) > 0) ? "pass" : "fail", JSON.stringify(r));
    }
    await mon?.end();
    await arc?.end();
  } finally {
    // Supabase's postgres role is not a superuser and cannot DROP OWNED BY; revoke the grants explicitly, then drop.
    for (const r of ["uniqbotz_hv_monitor", "uniqbotz_hv_archiver", "uniqbotz_hv_archiver_bypass"]) {
      await owner.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${r}`).catch(() => {});
      await owner.query(`REVOKE ALL ON SCHEMA public FROM ${r}`).catch(() => {});
      await owner.query(`DROP ROLE IF EXISTS ${r}`).catch((e) => results.push({ id: 0, name: `cleanup ${r}`, status: "manual", detail: `drop role manually: ${(e as Error).message}` }));
    }
    await owner.end().catch(() => {});
  }
  const dir = env.HV_RESULTS_DIR ?? "hosted-validation-results";
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${ref}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`), JSON.stringify({ ref, local, at: new Date().toISOString(), results }, null, 2));
  return results;
}

if (process.argv[1]?.endsWith("validate.ts")) {
  runHostedValidation().then((r) => {
    console.table(r.map((x) => ({ id: x.id, check: x.name, status: x.status, ms: x.ms ?? "", detail: x.detail.slice(0, 90) })));
    process.exit(r.some((x) => x.status === "fail") ? 1 : 0);
  }).catch((e) => { console.error((e as Error).message); process.exit(2); });
}
