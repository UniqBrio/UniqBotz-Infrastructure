import type { NextRequest } from "next/server";
import * as live from "@/server/live/service";
import { authenticate, HttpError, requirePrincipal, type Principal } from "@/server/auth/session";
import { withWriter } from "@/server/live/writer";
import { permissionsFor, type Action } from "@/lib/auth/permissions";
import type { SessionInfo } from "@/lib/domain/types";
import { createJob, cancelJob } from "../../../../../worker/jobs/jobs";
import { authorizeDeletion, recordApprovalDecision, ApprovalRefusedError, DuplicateApprovalError, type EvidenceKey } from "../../../../../worker/approvals/approvals";
import { setKillSwitch, KillSwitchRefusedError } from "../../../../../worker/controlplane/killSwitch";
import { NotReadyError } from "../../../../../worker/readiness/blockers";

/**
 * Control-plane API (Phase 3C).
 *
 * READS (GET): authenticated VIEWER+ when authentication is configured. While authentication is NOT
 * configured, reads stay anonymous ONLY as long as no production application is registered.
 *
 * WRITES (POST): authenticated + role-checked + CSRF-safe (token in the Authorization header). They record
 * decisions in the control plane. NONE of them deletes data: execution is the worker's, which re-validates
 * every gate and refuses while ALLOW_DELETION=false. PUT/PATCH/DELETE are always refused.
 */
export const runtime = "nodejs";

type Handler = (app: string | undefined, rest: string[], req: NextRequest) => Promise<unknown>;

const READS: Record<string, Handler> = {
  applications: () => live.listApplications(),
  "application-health": (_a, rest) => (rest[0] ? live.getApplicationHealth(rest[0]) : live.listApplicationHealth()),
  tables: (a) => live.listTables(a),
  policies: (a) => live.listRetentionPolicies(a),
  candidates: (a) => live.listArchiveCandidates(a),
  jobs: (a, rest) => (rest[0] && rest[1] === "review" ? live.getDeletionReview(rest[0]) : rest[0] ? live.getArchiveJob(rest[0]) : live.listArchiveJobs(a)),
  alerts: (a) => live.listAlerts(a),
  audit: (a) => live.listAuditLog(a),
  settings: () => live.getSettings(),
};

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

function errorResponse(e: unknown) {
  if (e instanceof HttpError) return json({ error: e.message, code: e.code }, e.status);
  if (e instanceof live.LiveNotConfiguredError) return json({ error: e.message }, 503);
  if (e instanceof ApprovalRefusedError) return json({ error: e.message, reasons: e.reasons, code: "DELETION_NOT_AUTHORIZED" }, 409);
  if (e instanceof DuplicateApprovalError) return json({ error: e.message, code: "DUPLICATE_APPROVAL" }, 409);
  if (e instanceof KillSwitchRefusedError) return json({ error: e.message, code: "FORBIDDEN" }, 403);
  if (e instanceof NotReadyError) return json({ error: e.message, codes: e.codes, code: "NOT_READY" }, 409);
  if ((e as Error)?.name === "DuplicateJobError") return json({ error: (e as Error).message, code: "DUPLICATE_JOB" }, 409);
  return json({ error: "control plane unavailable" }, 502);
}

async function session(req: NextRequest): Promise<SessionInfo> {
  const s = await authenticate(req);
  if (s.status !== "authenticated") {
    return { authMode: s.status === "disabled" || s.status === "misconfigured" ? "disabled" : "jwt-hs256", authenticated: false, subject: null, email: null,
      roles: [], permissions: [], notice: s.reason, productionDeletion: "DISABLED" };
  }
  const op = await live.lookupOperatorRoles(s.subject);
  const roles = op?.active ? op.roles : [];
  return { authMode: "jwt-hs256", authenticated: true, subject: s.subject, email: s.email, roles, permissions: permissionsFor(roles),
    notice: roles.length ? null : "signed in, but no role has been granted to this account", productionDeletion: "DISABLED" };
}

/** Read access: authenticated VIEWER+, or anonymous while auth is not configured AND no production app exists. */
async function authorizeRead(req: NextRequest) {
  const s = await authenticate(req);
  if (s.status === "disabled" || s.status === "misconfigured") {
    if (await live.hasProductionApplications()) {
      throw new HttpError(401, "AUTHENTICATION NOT CONFIGURED — production application data requires authentication", "AUTHENTICATION_NOT_CONFIGURED");
    }
    return;
  }
  await requirePrincipal(req, "view", live.lookupOperatorRoles, { write: false });
}

export async function GET(req: NextRequest, ctx: RouteContext<"/api/infra/[...path]">) {
  const { path } = await ctx.params;
  const [head, ...rest] = path;
  try {
    if (head === "session") return json(await session(req));
    const handler = head ? READS[head] : undefined;
    if (!handler) return json({ error: "not found" }, 404);
    await authorizeRead(req);
    const app = req.nextUrl.searchParams.get("app") ?? undefined;
    return json(await handler(app, rest, req));
  } catch (e) {
    return errorResponse(e);
  }
}

async function body(req: NextRequest): Promise<Record<string, unknown>> {
  try { return (await req.json()) as Record<string, unknown>; } catch { return {}; }
}

async function guard(req: NextRequest, action: Action): Promise<Principal> {
  return requirePrincipal(req, action, live.lookupOperatorRoles, { write: true });
}

export async function POST(req: NextRequest, ctx: RouteContext<"/api/infra/[...path]">) {
  const { path } = await ctx.params;
  const [head, id, sub] = path;
  try {
    // Start ARCHIVE_AND_VERIFY_ONLY (zero delete). The mode is fixed here; the dashboard can never create a deleting job.
    if (head === "jobs" && !id) {
      const p = await guard(req, "start_archive_verification");
      const b = await body(req);
      const jobId = `J-${Date.now().toString(36).toUpperCase()}`;
      return json(await withWriter((c) => createJob(c, { id: jobId, applicationId: String(b.applicationId ?? ""), groupRoot: String(b.groupRoot ?? ""),
        createdBy: p.subject, mode: "ARCHIVE_AND_VERIFY_ONLY" }).then((spec) => ({ jobId, mode: "ARCHIVE_AND_VERIFY_ONLY", spec }))), 201);
    }
    if (head === "jobs" && id && sub === "cancel") {
      const p = await guard(req, "cancel_job");
      const b = await body(req);
      await withWriter((c) => cancelJob(c, id, p.subject, String(b.reason ?? "cancelled from dashboard")));
      return json({ jobId: id, status: "cancelled" });
    }
    if (head === "jobs" && id && sub === "approvals") {
      const p = await guard(req, "approve_deletion");
      const b = await body(req);
      const decision = b.decision === "reject" ? "reject" : b.decision === "approve" ? "approve" : null;
      if (!decision) throw new HttpError(400, "decision must be approve or reject", "BAD_REQUEST");
      const rec = await withWriter((c) => recordApprovalDecision(c, { jobId: id, operatorId: p.subject, decision, comment: b.comment ? String(b.comment) : null,
        evidenceAck: b.evidenceAck as EvidenceKey | undefined }));
      return json({ approval: rec, productionDeletion: "DISABLED" }, 201);
    }
    if (head === "jobs" && id && sub === "authorization") {
      const p = await guard(req, "authorize_deletion");
      const b = await body(req);
      const rec = await withWriter((c) => authorizeDeletion(c, { jobId: id, operatorId: p.subject, evidenceAck: b.evidenceAck as EvidenceKey | undefined, confirmJobId: String(b.confirmJobId ?? "") }));
      return json({ authorization: rec, productionDeletion: "DISABLED", note: "authorization recorded; the worker re-validates every gate and refuses while ALLOW_DELETION=false" }, 201);
    }
    if (head === "kill-switch") {
      const b = await body(req);
      const engaged = b.engaged === true ? true : b.engaged === false ? false : null;
      if (engaged === null) throw new HttpError(400, "engaged must be true or false", "BAD_REQUEST");
      const p = await guard(req, engaged ? "engage_kill_switch" : "release_kill_switch");
      return json(await withWriter((c) => setKillSwitch(c, { engaged, operatorId: p.subject, reason: String(b.reason ?? "") })));
    }
    // Anything else (policy edits, settings, credentials, direct deletion) has no dashboard write path yet.
    await guard(req, "change_settings");
    throw new HttpError(403, "READ-ONLY: this change is not available from the dashboard in Phase 3C. Deletion is DISABLED (ALLOW_DELETION=false).", "NOT_AVAILABLE");
  } catch (e) {
    return errorResponse(e);
  }
}

const REFUSED = {
  error: "READ-ONLY: this method is not supported. Deletion is DISABLED (ALLOW_DELETION=false).",
  code: "METHOD_NOT_ALLOWED",
};
export async function PUT() {
  return json(REFUSED, 403);
}
export const PATCH = PUT;
export const DELETE = PUT;
