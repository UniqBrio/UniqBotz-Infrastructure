/**
 * Structured worker logging (Phase 3C §16). One JSON object per line.
 *
 * Only an allow-listed set of fields is emitted — arbitrary objects (rows, configs, errors with query
 * parameters) are never serialised wholesale. Free-text values pass through redact(), which removes
 * connection-string passwords, bearer/JWT tokens, Supabase keys and key=value secrets.
 *
 * NEVER log: passwords, tokens, service-role keys, secret values, or personal records. Row data is not
 * an accepted field; counts are.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogFields {
  application?: string;
  jobId?: string;
  table?: string;
  phase?: string;
  durationMs?: number;
  rows?: number;
  batch?: number;
  retry?: number;
  worker?: string;
  archiveObject?: string;
  checksum?: string;
  attempt?: number;
  status?: string;
  error?: unknown;
  errorKind?: string;
}

const ALLOWED: (keyof LogFields)[] = ["application", "jobId", "table", "phase", "durationMs", "rows", "batch", "retry", "worker", "archiveObject", "checksum", "attempt", "status", "errorKind"];

const PATTERNS: [RegExp, string][] = [
  [/(postgres(?:ql)?:\/\/[^:\s/@]+:)[^@\s]+@/gi, "$1[REDACTED]@"], // connection-string password
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[REDACTED_JWT]"],
  [/\bsb_(secret|publishable)_[A-Za-z0-9_-]+/g, "[REDACTED_SUPABASE_KEY]"],
  [/\b(password|passwd|pwd|secret|token|api[_-]?key|service[_-]?role[_-]?key|authorization)\s*[=:]\s*("[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1=[REDACTED]"],
];

export function redact(text: string): string {
  let out = text;
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out.length > 1000 ? `${out.slice(0, 1000)}…` : out;
}

export interface LogRecord extends Omit<LogFields, "error"> {
  ts: string;
  level: LogLevel;
  event: string;
  error?: string;
}

export type LogSink = (line: string) => void;

export class WorkerLogger {
  constructor(private sink: LogSink = (l) => process.stdout.write(`${l}\n`), private base: LogFields = {}) {}

  child(fields: LogFields): WorkerLogger {
    return new WorkerLogger(this.sink, { ...this.base, ...fields });
  }

  log(level: LogLevel, event: string, fields: LogFields = {}): LogRecord {
    const merged = { ...this.base, ...fields };
    const rec: LogRecord = { ts: new Date().toISOString(), level, event: redact(event) };
    for (const k of ALLOWED) {
      const v = merged[k];
      if (v === undefined || v === null) continue;
      (rec as unknown as Record<string, unknown>)[k] = typeof v === "string" ? redact(v) : typeof v === "number" ? v : redact(String(v));
    }
    if (merged.error !== undefined) {
      const e = merged.error as { name?: string; message?: string; code?: string };
      rec.error = redact(`${e?.name ?? "Error"}${e?.code ? `(${e.code})` : ""}: ${e?.message ?? String(merged.error)}`);
    }
    this.sink(JSON.stringify(rec));
    return rec;
  }
  info(event: string, f?: LogFields) { return this.log("info", event, f); }
  warn(event: string, f?: LogFields) { return this.log("warn", event, f); }
  error(event: string, f?: LogFields) { return this.log("error", event, f); }
  debug(event: string, f?: LogFields) { return this.log("debug", event, f); }
}

/** A logger that discards output (default in tests and library use). */
export const silentLogger = new WorkerLogger(() => {});
