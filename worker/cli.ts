#!/usr/bin/env tsx
/**
 * Operator CLI for the worker. Manual, one-shot commands only — NO scheduler (Phase 3B).
 *
 *   CONTROL_PLANE_DATABASE_URL=postgres://…   (server-side env; never NEXT_PUBLIC_*)
 *   npx tsx worker/cli.ts migrate
 *   npx tsx worker/cli.ts register <config.json>        # non-secret config; passwords are env: refs
 *   npx tsx worker/cli.ts collect <applicationId>       # read-only discovery + health + previews
 *   npx tsx worker/cli.ts job:create <app> <schema.table> <jobId> [ARCHIVE_AND_VERIFY_ONLY]
 *   npx tsx worker/cli.ts job:run <jobId>               # archive-and-verify; deletion refused while ALLOW_DELETION=false
 *   npx tsx worker/cli.ts status
 */
import { readFileSync } from "node:fs";
import pg from "pg";
import { loadWorkerConfig } from "./config";
import { EnvSecretResolver } from "./connection/secrets";
import { LocalDirectoryStore } from "./archive/store";
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
          cp, secrets, config, store: new LocalDirectoryStore(config.archiveStoreDir),
          openScratch: async () => { const s = new pg.Client({ connectionString: scratchUrl }); s.on("error", () => {}); await s.connect(); return s; },
        });
        console.log(JSON.stringify(await runner.run(args[0]!), null, 2));
        break;
      }
      case "status":
        console.table((await cp.query(`SELECT id, application_id, group_root, mode, status, attempt, updated_at FROM control.archive_jobs ORDER BY created_at DESC LIMIT 20`)).rows);
        console.log(`ALLOW_DELETION=${config.allowDeletion}  allowed environments=${config.deletionAllowedEnvironments.join(",")}`);
        break;
      default:
        console.log("commands: migrate | register <file> | collect <app> | job:create <app> <root> <id> | job:run <id> | status");
    }
  } finally {
    await cp.end();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
