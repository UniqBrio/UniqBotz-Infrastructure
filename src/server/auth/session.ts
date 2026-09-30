import { EnvSecretResolver } from "../../../worker/connection/secrets";
import type { SecretRef } from "../../../worker/connection/types";
import { permissionsFor, type Action, type Role } from "@/lib/auth/permissions";
import { AuthError, verifyHs256 } from "./jwt";

/**
 * Control-plane authentication boundary (Phase 3C §4). Server-side only.
 *
 *   CONTROL_PLANE_AUTH_MODE        unset | "disabled" → AUTHENTICATION NOT CONFIGURED (reads anonymous only while no
 *                                  production application is registered; every write refused)
 *                                  "jwt-hs256"        → session token verified server-side
 *   CONTROL_PLANE_AUTH_SECRET_REF  env:NAME reference to the token-signing secret (never the value)
 *   CONTROL_PLANE_AUTH_ISSUER      required expected "iss"
 *   CONTROL_PLANE_AUTH_AUDIENCE    required expected "aud"
 *   CONTROL_PLANE_AUTH_MAX_AGE_SECONDS  optional maximum session age
 *
 * Identity comes from the token; ROLES come from control.operator_roles. Tokens are read from the
 * Authorization header, or (reads only) from the uniqbotz_session cookie. Writes require the header, so a
 * cross-site request carrying only the cookie can never change anything.
 */
export type AuthMode = "disabled" | "jwt-hs256";

export interface AuthConfig {
  mode: AuthMode;
  secretRef: SecretRef | null;
  issuer: string | null;
  audience: string | null;
  maxAgeSeconds: number | null;
  problems: string[];
}

export function loadAuthConfig(env: Record<string, string | undefined> = process.env): AuthConfig {
  const raw = (env.CONTROL_PLANE_AUTH_MODE ?? "disabled").trim();
  const problems: string[] = [];
  const mode: AuthMode = raw === "jwt-hs256" ? "jwt-hs256" : "disabled";
  if (raw !== "disabled" && raw !== "jwt-hs256") problems.push(`unknown CONTROL_PLANE_AUTH_MODE '${raw}' — authentication stays disabled`);
  const secretRef = (env.CONTROL_PLANE_AUTH_SECRET_REF ?? null) as SecretRef | null;
  const issuer = env.CONTROL_PLANE_AUTH_ISSUER ?? null;
  const audience = env.CONTROL_PLANE_AUTH_AUDIENCE ?? null;
  if (mode === "jwt-hs256") {
    if (!secretRef || !/^(env|vault):[A-Za-z_][A-Za-z0-9_]*$/.test(secretRef)) problems.push("CONTROL_PLANE_AUTH_SECRET_REF must be a secret reference (env:NAME)");
    if (!issuer) problems.push("CONTROL_PLANE_AUTH_ISSUER is required");
    if (!audience) problems.push("CONTROL_PLANE_AUTH_AUDIENCE is required");
  }
  const maxAge = env.CONTROL_PLANE_AUTH_MAX_AGE_SECONDS ? Number(env.CONTROL_PLANE_AUTH_MAX_AGE_SECONDS) : null;
  return { mode, secretRef, issuer, audience, maxAgeSeconds: maxAge && maxAge > 0 ? maxAge : null, problems };
}

export type SessionState =
  | { status: "disabled"; reason: string }
  | { status: "misconfigured"; reason: string }
  | { status: "anonymous"; reason: string }
  | { status: "invalid"; reason: string; code: string }
  | { status: "authenticated"; subject: string; email: string | null; via: "header" | "cookie" };

function tokenFrom(req: Request): { token: string | null; via: "header" | "cookie" | null } {
  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) return { token: auth.slice(7).trim(), via: "header" };
  const cookie = req.headers.get("cookie") ?? "";
  const m = /(?:^|;\s*)uniqbotz_session=([^;]+)/.exec(cookie);
  return m ? { token: decodeURIComponent(m[1]!), via: "cookie" } : { token: null, via: null };
}

export async function authenticate(req: Request, env: Record<string, string | undefined> = process.env, now = new Date()): Promise<SessionState> {
  const cfg = loadAuthConfig(env);
  if (cfg.mode === "disabled") return { status: "disabled", reason: "AUTHENTICATION NOT CONFIGURED" };
  if (cfg.problems.length) return { status: "misconfigured", reason: `AUTHENTICATION NOT CONFIGURED: ${cfg.problems.join("; ")}` };
  let secret: string;
  try {
    secret = await new EnvSecretResolver(env).resolve(cfg.secretRef!, "APPLICATION_CREDENTIAL");
  } catch {
    return { status: "misconfigured", reason: "AUTHENTICATION NOT CONFIGURED: token-signing secret is not available" };
  }
  const { token, via } = tokenFrom(req);
  if (!token) return { status: "anonymous", reason: "sign-in required" };
  try {
    const c = verifyHs256(token, secret, { issuer: cfg.issuer!, audience: cfg.audience!, now, maxAgeSeconds: cfg.maxAgeSeconds ?? undefined });
    return { status: "authenticated", subject: c.sub, email: c.email, via: via! };
  } catch (e) {
    return { status: "invalid", reason: (e as Error).message, code: e instanceof AuthError ? e.code : "TOKEN_MALFORMED" };
  }
}

export interface Principal {
  subject: string;
  email: string | null;
  roles: Role[];
  permissions: Action[];
  via: "header" | "cookie";
}

export class HttpError extends Error {
  constructor(public status: number, message: string, public code: string) {
    super(message);
    this.name = "HttpError";
  }
}

/** Resolve roles for an authenticated subject. Unknown or disabled operators get no roles. */
export type RoleLookup = (subject: string) => Promise<{ active: boolean; roles: Role[] } | null>;

export async function requirePrincipal(req: Request, action: Action, lookup: RoleLookup, opts: { write: boolean; env?: Record<string, string | undefined>; now?: Date }): Promise<Principal> {
  const s = await authenticate(req, opts.env ?? process.env, opts.now);
  if (s.status === "disabled" || s.status === "misconfigured") {
    throw new HttpError(opts.write ? 403 : 401, opts.write
      ? `READ-ONLY: ${s.reason}. Changes require production authentication/authorization. Deletion is DISABLED (ALLOW_DELETION=false).`
      : s.reason, "AUTHENTICATION_NOT_CONFIGURED");
  }
  if (s.status === "anonymous") throw new HttpError(401, "sign-in required", "UNAUTHENTICATED");
  if (s.status === "invalid") throw new HttpError(401, `invalid session: ${s.reason}`, s.code);
  if (opts.write && s.via !== "header") throw new HttpError(403, "changes require the session token in the Authorization header", "CSRF_PROTECTION");
  const op = await lookup(s.subject);
  const roles = op?.active ? op.roles : [];
  const permissions = permissionsFor(roles);
  if (!permissions.includes(action)) throw new HttpError(403, `forbidden: '${action}' requires a role you do not hold`, "FORBIDDEN");
  return { subject: s.subject, email: s.email, roles, permissions, via: s.via };
}
