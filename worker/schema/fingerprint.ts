/**
 * Row fingerprint: SHA-256 of the row's text representation, under the pinned session settings
 * (connection/connect.ts). Encoded base64 (44 chars) — Phase 3A F9: hex doubled the keys file size.
 * Detects content changes. Does NOT detect schema-only changes → always pair with schemaHash().
 */
export const FINGERPRINT_ALGORITHM = "sha256(row::text)/base64" as const;

export function fingerprintSql(alias: string): string {
  return `encode(sha256(convert_to(${alias}::text, 'UTF8')), 'base64')`;
}
