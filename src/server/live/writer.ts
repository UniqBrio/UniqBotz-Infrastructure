import "server-only";
import pg from "pg";
import { HttpError } from "../auth/session";

/**
 * Control-plane WRITER connection, used only by authenticated, authorized mutations (Phase 3C).
 * A separate credential from the read-only dashboard pool: CONTROL_PLANE_WRITER_DATABASE_URL (server-side
 * only). Missing → every mutation is refused. The writer can record approvals and authorizations; it can
 * never delete application data — only the worker connects to application databases.
 */
export async function withWriter<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const url = process.env.CONTROL_PLANE_WRITER_DATABASE_URL;
  if (!url) throw new HttpError(503, "control-plane writer is not configured (CONTROL_PLANE_WRITER_DATABASE_URL)", "WRITER_NOT_CONFIGURED");
  const c = new pg.Client({ connectionString: url, application_name: "uniqbotz-dashboard-writer" });
  c.on("error", () => {});
  await c.connect();
  try {
    await c.query("SET search_path = control, public");
    return await fn(c);
  } finally {
    await c.end().catch(() => {});
  }
}
