/** PROTOTYPE / SYNTHETIC DATA ONLY — records the test environment for the report. */
import { execSync } from "node:child_process";
import { connect } from "./lib/db.ts";
import { Recorder } from "./lib/results.ts";

const rec = new Recorder("env", "Test environment");
const c = await connect("postgres", { pin: false });
const settings = (await c.query(`SELECT name, setting, unit FROM pg_settings WHERE name IN
  ('server_version','shared_buffers','work_mem','maintenance_work_mem','max_connections','autovacuum','autovacuum_naptime',
   'autovacuum_vacuum_scale_factor','autovacuum_vacuum_threshold','statement_timeout','lock_timeout','default_transaction_isolation','TimeZone')
  ORDER BY name`)).rows;
rec.measure("postgres_settings", Object.fromEntries(settings.map((s) => [s.name, s.unit ? `${s.setting} ${s.unit}` : s.setting])));
rec.measure("role", (await c.query(`SELECT current_user, rolsuper, rolbypassrls, rolcreaterole FROM pg_roles WHERE rolname = current_user`)).rows[0]);
const sh = (cmd: string) => { try { return execSync(cmd, { encoding: "utf8" }).trim(); } catch { return "n/a"; } };
rec.measure("container", {
  image: sh(`docker inspect -f '{{.Config.Image}}' uniqbotz-proto`),
  nanoCpus: sh(`docker inspect -f '{{.HostConfig.NanoCpus}}' uniqbotz-proto`),
  memoryBytes: sh(`docker inspect -f '{{.HostConfig.Memory}}' uniqbotz-proto`),
});
rec.measure("host", { node: process.version, cpus: sh("nproc"), kernel: sh("uname -r") });
rec.measure("databases_MB", Object.fromEntries((await c.query(
  `SELECT datname, round(pg_database_size(datname) / 1048576.0, 1)::float mb FROM pg_database WHERE datname LIKE '%synth%' OR datname = 'verify_scratch' ORDER BY 1`)).rows.map((r) => [r.datname, r.mb])));
await c.end();
rec.save();
