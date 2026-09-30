/** PROTOTYPE / SYNTHETIC DATA ONLY — writes machine-readable results for the report. */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RESULTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "results");

export interface Check {
  name: string;
  expected: unknown;
  actual: unknown;
  pass: boolean;
}

export class Recorder {
  checks: Check[] = [];
  measurements: Record<string, unknown> = {};
  notes: string[] = [];
  constructor(public id: string, public title: string) {}

  check(name: string, expected: unknown, actual: unknown, pass = JSON.stringify(expected) === JSON.stringify(actual)) {
    this.checks.push({ name, expected, actual, pass });
    console.log(`${pass ? "PASS" : "FAIL"}  ${name}  expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
    return pass;
  }

  measure(key: string, value: unknown) {
    this.measurements[key] = value;
    console.log(`MEASURE ${key} = ${JSON.stringify(value)}`);
  }

  note(text: string) {
    this.notes.push(text);
    console.log(`NOTE ${text}`);
  }

  save() {
    mkdirSync(RESULTS_DIR, { recursive: true });
    const passed = this.checks.filter((c) => c.pass).length;
    const out = {
      id: this.id,
      title: this.title,
      label: "PROTOTYPE / SYNTHETIC DATA ONLY",
      ranAt: new Date().toISOString(),
      summary: { checks: this.checks.length, passed, failed: this.checks.length - passed },
      checks: this.checks,
      measurements: this.measurements,
      notes: this.notes,
    };
    writeFileSync(join(RESULTS_DIR, `${this.id}.json`), JSON.stringify(out, null, 2) + "\n");
    console.log(`\n${this.id}: ${passed}/${this.checks.length} checks passed`);
    if (passed !== this.checks.length) process.exitCode = 1;
    return out;
  }
}
