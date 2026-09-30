/**
 * PROTOTYPE / SYNTHETIC DATA ONLY.
 * Creates the disposable databases and loads generated data. Local container only.
 *   npm run db:start && npm run db:seed
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DBS, connect, ms, now } from "./lib/db.ts";

const sqlDir = join(dirname(fileURLToPath(import.meta.url)), "..", "sql");

async function recreate(db: string) {
  const admin = await connect("postgres", { pin: false });
  await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${db}`);
  await admin.end();
}

async function load(db: string, file: string | null) {
  await recreate(db);
  if (!file) return;
  const c = await connect(db, { pin: false });
  const t = now();
  await c.query(readFileSync(join(sqlDir, file), "utf8"));
  const size = await c.query(
    `SELECT relname, n_live_tup::bigint AS rows, pg_size_pretty(pg_total_relation_size(relid)) AS size
     FROM pg_stat_user_tables ORDER BY pg_total_relation_size(relid) DESC`,
  );
  const db_size = (await c.query(`SELECT pg_size_pretty(pg_database_size(current_database())) s`)).rows[0].s;
  console.log(`${db}: loaded ${file} in ${(ms(t) / 1000).toFixed(1)} s, database ${db_size}`);
  console.table(size.rows);
  await c.end();
}

await load(DBS.rosifit, "rosifit.sql");
await load(DBS.jalsa, "jalsa.sql");
await load(DBS.control, "control_plane.sql");
await load(DBS.scratch, null);
console.log("seed complete (synthetic data only)");
