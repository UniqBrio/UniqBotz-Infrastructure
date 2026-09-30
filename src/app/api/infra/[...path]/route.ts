import type { NextRequest } from "next/server";
import * as live from "@/server/live/service";

/**
 * READ-ONLY live monitoring API for the dashboard (Phase 3B).
 * GET only. Every write (policy edits, settings, deletion) is refused until production authentication
 * and authorization exist — and deletion is disabled regardless (ALLOW_DELETION=false in the worker).
 */
export const runtime = "nodejs";

type Handler = (app: string | undefined, rest: string[]) => Promise<unknown>;

const ROUTES: Record<string, Handler> = {
  applications: () => live.listApplications(),
  "application-health": (_a, rest) => (rest[0] ? live.getApplicationHealth(rest[0]) : live.listApplicationHealth()),
  tables: (a) => live.listTables(a),
  policies: (a) => live.listRetentionPolicies(a),
  candidates: (a) => live.listArchiveCandidates(a),
  jobs: (a, rest) => (rest[0] ? live.getArchiveJob(rest[0]) : live.listArchiveJobs(a)),
  alerts: (a) => live.listAlerts(a),
  audit: (a) => live.listAuditLog(a),
  settings: () => live.getSettings(),
};

export async function GET(req: NextRequest, ctx: RouteContext<"/api/infra/[...path]">) {
  const { path } = await ctx.params;
  const [head, ...rest] = path;
  const handler = head ? ROUTES[head] : undefined;
  if (!handler) return Response.json({ error: "not found" }, { status: 404 });
  try {
    const app = req.nextUrl.searchParams.get("app") ?? undefined;
    return Response.json(await handler(app, rest), { headers: { "cache-control": "no-store" } });
  } catch (e) {
    const notConfigured = e instanceof live.LiveNotConfiguredError;
    return Response.json({ error: notConfigured ? e.message : "control plane unavailable" }, { status: notConfigured ? 503 : 502 });
  }
}

const READ_ONLY = {
  error: "READ-ONLY: live monitoring cannot change policies, settings or data in Phase 3B. " +
    "Policy editing requires production authentication/authorization (not yet implemented). Deletion is DISABLED (ALLOW_DELETION=false).",
};

export async function POST() {
  return Response.json(READ_ONLY, { status: 403 });
}
export const PUT = POST;
export const PATCH = POST;
export const DELETE = POST;
