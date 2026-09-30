/** PROTOTYPE / SYNTHETIC DATA ONLY — prints a pass/fail table of all result files. */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const dir = new URL("../results/", import.meta.url).pathname;
const rows = readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "summary.json").sort().map((f) => {
  const r = JSON.parse(readFileSync(join(dir, f), "utf8"));
  return { id: r.id, title: r.title, checks: r.summary.checks, passed: r.summary.passed, failed: r.summary.failed, ranAt: r.ranAt };
});
console.table(rows);
writeFileSync(join(dir, "summary.json"), JSON.stringify(rows, null, 2) + "\n");
