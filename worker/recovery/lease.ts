import type pg from "pg";

export class LeaseHeldError extends Error {
  constructor(resource: string, public owner: string) {
    super(`${resource} is leased by ${owner}`);
    this.name = "LeaseHeldError";
  }
}
export class LeaseLostError extends Error {
  constructor(resource: string) {
    super(`lease lost for ${resource}`);
    this.name = "LeaseLostError";
  }
}

/** Acquire (or take over an expired) lease. Returns whether an expired lease from another owner was taken over. */
export async function acquireLease(cp: pg.Client, resource: string, owner: string, seconds: number): Promise<{ takeover: string | null }> {
  const prev = (await cp.query(`SELECT owner, expires_at < now() AS expired FROM control.worker_leases WHERE resource = $1`, [resource])).rows[0];
  const r = await cp.query(
    `INSERT INTO control.worker_leases (resource, owner, expires_at) VALUES ($1, $2, now() + make_interval(secs => $3))
     ON CONFLICT (resource) DO UPDATE SET owner = EXCLUDED.owner, acquired_at = now(), heartbeat_at = now(), expires_at = EXCLUDED.expires_at
       WHERE control.worker_leases.owner = EXCLUDED.owner OR control.worker_leases.expires_at < now()
     RETURNING owner`,
    [resource, owner, seconds],
  );
  if (r.rowCount !== 1) throw new LeaseHeldError(resource, prev?.owner ?? "unknown");
  return { takeover: prev && prev.owner !== owner && prev.expired ? prev.owner : null };
}

export async function heartbeat(cp: pg.Client, resource: string, owner: string, seconds: number): Promise<void> {
  const r = await cp.query(
    `UPDATE control.worker_leases SET heartbeat_at = now(), expires_at = now() + make_interval(secs => $3)
     WHERE resource = $1 AND owner = $2 AND expires_at > now()`,
    [resource, owner, seconds]);
  if (r.rowCount !== 1) throw new LeaseLostError(resource);
}

export async function releaseLease(cp: pg.Client, resource: string, owner: string): Promise<void> {
  await cp.query(`DELETE FROM control.worker_leases WHERE resource = $1 AND owner = $2`, [resource, owner]);
}
