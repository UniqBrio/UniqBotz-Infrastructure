#!/usr/bin/env tsx
/**
 * Operator CLI for the worker. Manual, one-shot commands only — NO scheduler (SCHEDULING DISABLED).
 *
 *   CONTROL_PLANE_DATABASE_URL=postgres://…   (server-side env; never NEXT_PUBLIC_*)
 *   npx tsx worker/cli.ts migrate
 *   npx tsx worker/cli.ts register <config.json>        # non-secret config; passwords are env: refs
 *   npx tsx worker/cli.ts collect <applicationId>       # read-only discovery + health + previews
 *   npx tsx worker/cli.ts job:create <app> <schema.table> <jobId> [ARCHIVE_AND_VERIFY_ONLY]
 *   npx tsx worker/cli.ts job:run <jobId>               # archive-and-verify; deletion refused while ALLOW_DELETION=false
 *   npx tsx worker/cli.ts status
 *   npx tsx worker/cli.ts discover <applicationId> [report.md]   # READ-ONLY discovery + report (first production step)
 *   npx tsx worker/cli.ts operator:add <subject> <email>         # bootstrap an operator identity
 *   npx tsx worker/cli.ts operator:grant <subject> <VIEWER|OPERATOR|APPROVER|ADMIN>
 *
 * There is no approve/authorize/delete command: approvals and authorization are recorded by authenticated
 * people through the control-plane API, and deletion stays disabled (ALLOW_DELETION=false).
 */
import { readFileSync, writeFileSync } from "node:fs";
import pg from "pg";
import { loadWorkerConfig } from "./config";
import { EnvSecretResolver } from "./connection/secrets";
import { createArchiveStorage } from "./archive/providers";
import { runReadOnlyDiscovery } from "./discovery/readOnlyDiscovery";
import { grantRole, upsertOperator } from "./controlplane/operators";
import { isRole } from "../src/lib/auth/permissions";
import { migrateControlPlane } from "./controlplane/migrate";
import { registerApplication } from "./controlplane/repository";
import { collectApplication } from "./health/collector";
import { createJob } from "./jobs/jobs";
import { JobRunner } from "./jobs/runner";
import type { ApplicationConfig } from "./connection/types";

async function controlPlane() {
  const url = process.env.CONTROL_PLANE_DATABASE_URL;
  if (!url) throw new Error("CONTROL_PLANE_DATABASE_URL is not set");
  const c = new pg.Client({ connectionString: url, application_name: "uniqbotz-worker-cli" });
  c.on("error", () => {});
  await c.connect();
  await c.query("SET search_path = control, public");
  return c;
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const config = loadWorkerConfig();
  const cp = await controlPlane();
  const secrets = new EnvSecretResolver();
  try {
    switch (cmd) {
      case "migrate":
        console.log("applied:", await migrateControlPlane(cp));
        break;
      case "register": {
        const cfg = JSON.parse(readFileSync(args[0]!, "utf8")) as ApplicationConfig;
        await registerApplication(cp, cfg);
        console.log(`registered ${cfg.id} (${cfg.environment})`);
        break;
      }
      case "collect":
        console.log(JSON.stringify(await collectApplication(cp, secrets, args[0]!), null, 2));
        break;
      case "job:create":
        console.log(JSON.stringify(await createJob(cp, { applicationId: args[0]!, groupRoot: args[1]!, id: args[2]!, createdBy: `cli:${process.env.USER ?? "operator"}`,
          mode: (args[3] as "ARCHIVE_AND_VERIFY_ONLY") ?? "ARCHIVE_AND_VERIFY_ONLY" }), null, 2));
        break;
      case "job:run": {
        const scratchUrl = process.env.VERIFY_SCRATCH_DATABASE_URL;
        if (!scratchUrl) throw new Error("VERIFY_SCRATCH_DATABASE_URL is not set (restore verification needs a scratch database)");
        const runner = new JobRunner({
          cp, secrets, config, store: createArchiveStorage(), // null → ARCHIVE EXECUTION UNAVAILABLE
          openScratch: async () => { const s = new pg.Client({ connectionString: scratchUrl }); s.on("error", () => {}); await s.connect(); return s; },
        });
        console.log(JSON.stringify(await runner.run(args[0]!), null, 2));
        break;
      }
      case "status":
        console.table((await cp.query(`SELECT id, application_id, group_root, mode, status, attempt, updated_at FROM control.archive_jobs ORDER BY created_at DESC LIMIT 20`)).rows);
        console.log(`ALLOW_DELETION=${config.allowDeletion}  allowed environments=${config.deletionAllowedEnvironments.join(",")}`);
        break;
      case "discover": {
        const out = await runReadOnlyDiscovery(cp, secrets, args[0]!);
        if (args[1]) writeFileSync(args[1], out.report);
        else console.log(out.report);
        console.error(`read-only discovery: ${out.collected.tables} tables, session read-only=${out.sessionReadOnly}, write-privilege warnings=${out.writePrivileges.length}`);
        break;
      }
      case "operator:add":
        await upsertOperator(cp, { id: args[0]!, email: args[1]! }, `cli:${process.env.USER ?? "operator"}`);
        console.log(`operator ${args[0]} registered (no role granted)`);
        break;
      case "operator:grant": {
        const role = args[1] ?? "";
        if (!isRole(role)) throw new Error("role must be VIEWER, OPERATOR, APPROVER or ADMIN");
        await grantRole(cp, args[0]!, role, `cli:${process.env.USER ?? "operator"}`);
        console.log(`granted ${role} to ${args[0]}`);
        break;
      }
      default:
        console.log("commands: migrate | register <file> | collect <app> | discover <app> [out.md] | job:create <app> <root> <id> | job:run <id> | status | operator:add <sub> <email> | operator:grant <sub> <role>");
    }
  } finally {
    await cp.end();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
