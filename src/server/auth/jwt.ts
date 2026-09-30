import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Minimal, strict HS256 JWT verification (no dependency). Compatible with identity providers that sign
 * session tokens with a shared secret (e.g. Supabase Auth legacy JWT secret). The provider itself is an
 * undecided choice (checklist S-1); this verifier is isolated so an asymmetric (JWKS) verifier can replace it.
 *
 * Rejects: any alg other than HS256 (incl. "none"), bad signature, missing/expired exp, future nbf,
 * wrong iss/aud, missing sub, tokens older than maxAgeSeconds (by iat).
 */
export type AuthErrorCode = "TOKEN_MISSING" | "TOKEN_MALFORMED" | "TOKEN_ALG" | "TOKEN_SIGNATURE" | "TOKEN_EXPIRED" | "TOKEN_NOT_YET_VALID"
  | "TOKEN_ISSUER" | "TOKEN_AUDIENCE" | "TOKEN_SUBJECT" | "TOKEN_TOO_OLD";

export class AuthError extends Error {
  constructor(public code: AuthErrorCode, message: string) {
    super(message);
    this.name = "AuthError";
  }
}

export interface VerifiedClaims {
  sub: string;
  email: string | null;
  iss: string;
  aud: string | string[];
  exp: number;
  iat: number | null;
}

export interface VerifyOptions {
  issuer: string;
  audience: string;
  now?: Date;
  clockSkewSeconds?: number;
  maxAgeSeconds?: number;
}

const b64url = (buf: Buffer) => buf.toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
const fromB64url = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

export function verifyHs256(token: string | null | undefined, secret: string, opts: VerifyOptions): VerifiedClaims {
  if (!token) throw new AuthError("TOKEN_MISSING", "no session token");
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]*$/.test(p))) throw new AuthError("TOKEN_MALFORMED", "malformed token");
  let header: { alg?: string; typ?: string };
  let claims: Record<string, unknown>;
  try {
    header = JSON.parse(fromB64url(parts[0]!).toString("utf8"));
    claims = JSON.parse(fromB64url(parts[1]!).toString("utf8"));
  } catch {
    throw new AuthError("TOKEN_MALFORMED", "malformed token");
  }
  if (header.alg !== "HS256") throw new AuthError("TOKEN_ALG", `unsupported token algorithm ${String(header.alg)}`);
  const expected = createHmac("sha256", secret).update(`${parts[0]}.${parts[1]}`).digest();
  const given = fromB64url(parts[2]!);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new AuthError("TOKEN_SIGNATURE", "invalid token signature");
  const now = Math.floor((opts.now ?? new Date()).getTime() / 1000);
  const skew = opts.clockSkewSeconds ?? 30;
  if (typeof claims.exp !== "number") throw new AuthError("TOKEN_EXPIRED", "token has no expiry");
  if (claims.exp + skew <= now) throw new AuthError("TOKEN_EXPIRED", "token expired");
  if (typeof claims.nbf === "number" && claims.nbf - skew > now) throw new AuthError("TOKEN_NOT_YET_VALID", "token not yet valid");
  if (claims.iss !== opts.issuer) throw new AuthError("TOKEN_ISSUER", "unexpected token issuer");
  const aud = claims.aud;
  const audOk = Array.isArray(aud) ? aud.includes(opts.audience) : aud === opts.audience;
  if (!audOk) throw new AuthError("TOKEN_AUDIENCE", "unexpected token audience");
  if (typeof claims.sub !== "string" || !claims.sub) throw new AuthError("TOKEN_SUBJECT", "token has no subject");
  const iat = typeof claims.iat === "number" ? claims.iat : null;
  if (opts.maxAgeSeconds && (iat === null || now - iat > opts.maxAgeSeconds)) throw new AuthError("TOKEN_TOO_OLD", "session is too old — sign in again");
  return { sub: claims.sub, email: typeof claims.email === "string" ? claims.email : null, iss: claims.iss as string, aud: aud as string, exp: claims.exp, iat };
}

/** Test and local-tooling helper. Production tokens are issued by the identity provider, never by this server. */
export function signHs256(claims: Record<string, unknown>, secret: string, header: Record<string, unknown> = { alg: "HS256", typ: "JWT" }): string {
  const h = b64url(Buffer.from(JSON.stringify(header)));
  const p = b64url(Buffer.from(JSON.stringify(claims)));
  return `${h}.${p}.${b64url(createHmac("sha256", secret).update(`${h}.${p}`).digest())}`;
}
