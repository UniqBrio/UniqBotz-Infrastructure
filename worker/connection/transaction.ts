import type pg from "pg";

export class NestedTransactionError extends Error {
  constructor() {
    super("refused: caller already has an open transaction (a nested BEGIN would let our COMMIT commit the caller's work)");
    this.name = "NestedTransactionError";
  }
}

/**
 * BEGIN that refuses to nest (Phase 3A F6). Postgres only WARNS on a nested BEGIN, and our later
 * COMMIT would then commit the caller's transaction — so detect the notice and abort.
 */
export async function beginOwned(c: pg.Client, sql = "BEGIN"): Promise<void> {
  let nested = false;
  const onNotice = (n: { message?: string }) => {
    if (/already a transaction in progress/.test(n.message ?? "")) nested = true;
  };
  c.on("notice", onNotice);
  try {
    await c.query(sql);
  } finally {
    c.off("notice", onNotice);
  }
  if (nested) throw new NestedTransactionError();
}
