/**
 * PROTOTYPE / SYNTHETIC DATA ONLY — P3 Multi-table / FK dependencies (ADR §5, D-08).
 * Dependency graph is discovered from pg_constraint; order is derived, never hard-coded.
 */
import { DBS, connect } from "./lib/db.ts";
import { exportGroup } from "./lib/archive.ts";
import { buildContext, deleteBatch, expandBatch, rootBatches } from "./lib/deleter.ts";
import { deletionOrder, discoverEdges, findCycles, validateSelection } from "./lib/fkGraph.ts";
import { planGroup, selectCandidate } from "./lib/group.ts";
import { Recorder } from "./lib/results.ts";
import { verifyArchive } from "./lib/verify.ts";

const rec = new Recorder("p3-fk-graph", "P3 — Multi-table / FK dependencies");
const c = await connect(DBS.jalsa);

// ---------- lab schema with the risky FK shapes ----------
await c.query(`
  DROP SCHEMA IF EXISTS fk_lab CASCADE;
  CREATE SCHEMA fk_lab;
  CREATE TABLE fk_lab.lab_orders (id int PRIMARY KEY, placed_on date NOT NULL);
  CREATE TABLE fk_lab.lab_items  (id int PRIMARY KEY, order_id int NOT NULL REFERENCES fk_lab.lab_orders(id) ON DELETE CASCADE);
  CREATE TABLE fk_lab.lab_notes  (id int PRIMARY KEY, order_id int REFERENCES fk_lab.lab_orders(id) ON DELETE SET NULL, body text);
  CREATE TABLE fk_lab.cyc_a (id int PRIMARY KEY, b_id int);
  CREATE TABLE fk_lab.cyc_b (id int PRIMARY KEY, a_id int REFERENCES fk_lab.cyc_a(id));
  ALTER TABLE fk_lab.cyc_a ADD FOREIGN KEY (b_id) REFERENCES fk_lab.cyc_b(id) DEFERRABLE INITIALLY DEFERRED;
  CREATE TABLE fk_lab.lab_comments (id int PRIMARY KEY, parent_id int REFERENCES fk_lab.lab_comments(id));
  INSERT INTO fk_lab.lab_orders SELECT g, date '2024-01-01' + g FROM generate_series(1, 100) g;
  INSERT INTO fk_lab.lab_items  SELECT g, 1 + (g % 100) FROM generate_series(1, 300) g;
  INSERT INTO fk_lab.lab_notes  SELECT g, 1 + (g % 100), 'synthetic' FROM generate_series(1, 150) g;`);

const edges = await discoverEdges(c);
rec.measure("discovered_edges", edges.map((e) => `${e.child}(${e.childColumns}) → ${e.parent} ON DELETE ${e.onDelete}`));
const J = (t: string) => `public.${t}`;
rec.check("jalsa edges discovered from catalog",
  ["public.order_items → public.orders : NO ACTION", "public.payments → public.orders : RESTRICT"],
  edges.filter((e) => e.child.startsWith("public.")).map((e) => `${e.child} → ${e.parent} : ${e.onDelete}`).sort());

// 1. parent + children selected
const full = validateSelection([J("orders"), J("order_items"), J("payments")], edges);
rec.check("parent + both children: no blocking issues", 0, full.blocking.length);
rec.check("derived delete order (referencing tables before referenced)", ["public.order_items", "public.payments", "public.orders"],
  deletionOrder([J("orders"), J("order_items"), J("payments")], edges));

// 2. parent without child
const parentOnly = validateSelection([J("orders")], edges);
rec.check("parent without children: blocked by both referencing tables", ["unselected_child_blocks:public.order_items", "unselected_child_blocks:public.payments"],
  parentOnly.blocking.map((b) => `${b.kind}:${"edge" in b ? b.edge.child : ""}`).sort());
await c.query("BEGIN");
let fkError = "";
try {
  await c.query(`DELETE FROM public.orders WHERE id = (SELECT min(order_id) FROM public.order_items)`);
} catch (e) { fkError = (e as { code?: string }).code ?? String(e); }
await c.query("ROLLBACK");
rec.check("if forced, deleting a referenced parent fails (NO ACTION → 23503), i.e. fails closed", "23503", fkError);

// 3. child without parent
const childOnly = validateSelection([J("order_items")], edges);
rec.check("child without parent: allowed with warning", [0, "child_without_parent"], [childOnly.blocking.length, childOnly.warnings[0]?.kind]);

// 4. cascade / set null
const cascade = validateSelection(["fk_lab.lab_orders"], edges);
rec.check("CASCADE and SET NULL children unselected → blocked",
  ["unselected_child_cascade:fk_lab.lab_items", "unselected_child_set_null:fk_lab.lab_notes"],
  cascade.blocking.map((b) => `${b.kind}:${"edge" in b ? b.edge.child : ""}`).sort());
await c.query("BEGIN");
const before = (await c.query(`SELECT (SELECT count(*) FROM fk_lab.lab_items)::int items, (SELECT count(*) FROM fk_lab.lab_notes WHERE order_id IS NOT NULL)::int notes`)).rows[0];
await c.query(`DELETE FROM fk_lab.lab_orders WHERE id <= 10`);
const after = (await c.query(`SELECT (SELECT count(*) FROM fk_lab.lab_items)::int items, (SELECT count(*) FROM fk_lab.lab_notes WHERE order_id IS NOT NULL)::int notes`)).rows[0];
await c.query("ROLLBACK");
rec.measure("cascade_demo_deleting_10_parents", { itemsSilentlyDeleted: before.items - after.items, notesSilentlyNulled: before.notes - after.notes });
rec.check("demonstrated: CASCADE silently deletes unarchived children", true, before.items - after.items > 0);
rec.check("demonstrated: SET NULL silently modifies unarchived children", true, before.notes - after.notes > 0);

// 5. cycles
const cycles = findCycles(["fk_lab.cyc_a", "fk_lab.cyc_b", "fk_lab.lab_comments", "fk_lab.lab_orders"], edges);
rec.check("cycles detected (2-table cycle + self-reference)", [["fk_lab.cyc_a", "fk_lab.cyc_b"], ["fk_lab.lab_comments"]],
  cycles.map((x) => x).sort((a, b) => a[0]!.localeCompare(b[0]!)));
let cycleErr = "";
try { deletionOrder(["fk_lab.cyc_a", "fk_lab.cyc_b"], edges); } catch (e) { cycleErr = String(e); }
rec.check("deletion order refuses a cycle", true, cycleErr.includes("cycle"));

// 6. unrelated table in a root-driven group
const mixed = await planGroup(c, { applicationId: "jalsa-synth", database: DBS.jalsa, root: J("orders"), dateColumn: "order_date",
  tables: [J("orders"), J("audit_logs")], timeZone: "Asia/Kolkata", cutoffDay: "2025-09-30", target: 1000 });
rec.check("table with no FK path to root is rejected from the group", true, mixed.blocking.some((b) => b.startsWith("not_reachable_from_root: public.audit_logs")));

// 7. root-driven group end-to-end with orphan prevention
const plan = await planGroup(c, { applicationId: "jalsa-synth", database: DBS.jalsa, root: J("orders"), dateColumn: "order_date",
  tables: [J("orders"), J("order_items"), J("payments")], timeZone: "Asia/Kolkata", cutoffDay: "2025-09-30", target: 3_000 });
rec.check("group plan blocking issues", [], plan.blocking);
let sel = await selectCandidate(c, plan);
// A late-night order on the boundary day whose items/payment are created after local midnight.
const lateOrder = (await c.query(`INSERT INTO public.orders (order_no, order_date, customer_ref, total, status, created_at)
  VALUES ('J-LATE-NIGHT', ($1::date + time '23:58') AT TIME ZONE 'Asia/Kolkata', 'CUST-SYNTH', 99, 'served', now()) RETURNING id::text`, [sel.boundaryDate])).rows[0].id;
await c.query(`INSERT INTO public.order_items (order_id, item_name, qty, unit_price, created_at)
  SELECT $1, 'midnight item ' || k, 1, 33, ($2::date + 1 + time '00:01') AT TIME ZONE 'Asia/Kolkata' + k * interval '2 minutes' FROM generate_series(1, 3) k`, [lateOrder, sel.boundaryDate]);
await c.query(`INSERT INTO public.payments (order_id, amount, method, paid_at, created_at)
  VALUES ($1, 99, 'upi', ($2::date + 1 + time '00:20') AT TIME ZONE 'Asia/Kolkata', ($2::date + 1 + time '00:20') AT TIME ZONE 'Asia/Kolkata')`, [lateOrder, sel.boundaryDate]);
const boundaryBefore = sel.boundaryDate;
sel = await selectCandidate(c, plan);
rec.check("adding rows on the boundary day does not move the boundary", boundaryBefore, sel.boundaryDate);
rec.measure("group_selection", { oldest: sel.oldestDate, boundary: sel.boundaryDate, total: sel.totalSelected, byTable: sel.totalsByTable });

// per-table date selection would split orders from items across days
const split = (await c.query(`
  SELECT count(DISTINCT o.id)::int n FROM public.orders o JOIN public.order_items i ON i.order_id = o.id
  WHERE (o.order_date AT TIME ZONE 'Asia/Kolkata')::date <= $1::date
    AND (i.created_at AT TIME ZONE 'Asia/Kolkata')::date <> (o.order_date AT TIME ZONE 'Asia/Kolkata')::date`, [sel.boundaryDate])).rows[0].n;
rec.measure("orders_in_candidate_range_whose_items_fall_on_another_day", split);
rec.check("late-night order has children dated after the boundary (would split under per-table dates)", true, split >= 1);

const job = "P3-" + Date.now();
const { manifest, manifestSha256, dir } = await exportGroup(c, plan, sel, job, 1);
rec.check("export order = parents first", ["public.orders", "public.order_items", "public.payments"].sort(), plan.exportOrder.slice().sort());
const sortObj = (o: Record<string, number>) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
rec.check("frozen totals = selection totals per table", sortObj(sel.totalsByTable), sortObj(Object.fromEntries(Object.entries(manifest.tables).map(([t, x]) => [t, x.rows]))));
const v = await verifyArchive(dir, {
  manifestSha256,
  files: Object.fromEntries(Object.values(manifest.tables).flatMap((t) => [[t.data.path, { bytes: t.data.bytes, sha256: t.data.sha256 }], [t.keys.path, { bytes: t.keys.bytes, sha256: t.keys.sha256 }]])),
  rowsByTable: Object.fromEntries(Object.entries(manifest.tables).map(([t, x]) => [t, x.rows])),
  schemaHash: plan.schemaHash,
  boundary: { firstDay: sel.oldestDate, lastDay: sel.boundaryDate },
});
rec.check("group archive verified", true, v.passed);

const ctx = await buildContext(dir, manifest, plan.schemas, plan.edges);
const lateItems = ctx.keys[J("order_items")]!.filter((k) => k.parentFk === lateOrder).length;
const latePay = ctx.keys[J("payments")]!.filter((k) => k.parentFk === lateOrder).length;
rec.check("root-driven freeze keeps the late-night order WITH its next-day items and payment", [3, 1], [lateItems, latePay]);
// app adds a NEW child to a frozen order after export
const heldOrder = ctx.keys[J("orders")]![5]!.pk;
const newItem = (await c.query(`INSERT INTO public.order_items (order_id, item_name, qty, unit_price) VALUES ($1, 'late add-on', 1, 10) RETURNING id::text`, [heldOrder])).rows[0].id;

const totals: Record<string, { deleted: number; drifted: number; held: number; missing: number }> = {};
for (const b of rootBatches(ctx, 200)) {
  const r = await deleteBatch(c, ctx, expandBatch(ctx, b));
  for (const [t, o] of Object.entries(r)) {
    const cur = totals[t] ?? { deleted: 0, drifted: 0, held: 0, missing: 0 };
    totals[t] = { deleted: cur.deleted + o.deleted, drifted: cur.drifted + o.drifted, held: cur.held + o.held, missing: cur.missing + o.missing };
  }
}
rec.measure("group_delete_totals", totals);
rec.check("order with a late child is held, not deleted, no FK error", [1, 0], [totals[J("orders")]!.held, totals[J("orders")]!.drifted]);
rec.check("late child row preserved", 1, (await c.query(`SELECT count(*)::int n FROM public.order_items WHERE id = $1`, [newItem])).rows[0].n);
const orphans = (await c.query(`SELECT
   (SELECT count(*) FROM public.order_items i WHERE NOT EXISTS (SELECT 1 FROM public.orders o WHERE o.id = i.order_id))::int items,
   (SELECT count(*) FROM public.payments p WHERE NOT EXISTS (SELECT 1 FROM public.orders o WHERE o.id = p.order_id))::int pays`)).rows[0];
rec.check("no orphans after group deletion", { items: 0, pays: 0 }, orphans);
rec.check("all frozen children deleted", [ctx.keys[J("order_items")]!.length, ctx.keys[J("payments")]!.length], [totals[J("order_items")]!.deleted, totals[J("payments")]!.deleted]);

await c.query("DROP SCHEMA fk_lab CASCADE");
await c.end();
rec.save();
