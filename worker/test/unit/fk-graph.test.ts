import { describe, expect, it } from "vitest";
import { deletionOrder, findCycles, graphHash, validateSelection, type FkEdge } from "../../discovery/fkGraph";

const e = (name: string, child: string, parent: string, onDelete: FkEdge["onDelete"] = "NO ACTION"): FkEdge =>
  ({ name, child, parent, childColumns: ["x"], parentColumns: ["id"], onDelete });

describe("FK graph", () => {
  const edges = [e("b_a", "s.b", "s.a"), e("c_b", "s.c", "s.b", "CASCADE"), e("d_a", "s.d", "s.a", "SET NULL")];

  it("derives children-first deletion order from the graph", () => {
    expect(deletionOrder(["s.a", "s.b", "s.c"], edges)).toEqual(["s.c", "s.b", "s.a"]);
  });

  it("blocks when a selected parent has an unselected child (CASCADE, SET NULL, NO ACTION)", () => {
    const r = validateSelection(["s.a", "s.b"], edges);
    const kinds = r.blocking.map((b) => b.kind).sort();
    expect(kinds).toEqual(["unselected_child_cascade", "unselected_child_set_null"]);
    expect(validateSelection(["s.a"], edges).blocking.map((b) => b.kind)).toContain("unselected_child_blocks");
    expect(validateSelection(["s.a", "s.b", "s.c", "s.d"], edges).blocking).toEqual([]);
  });

  it("warns for a selected child whose parent is not selected", () => {
    expect(validateSelection(["s.c"], edges).warnings.map((w) => w.kind)).toEqual(["child_without_parent"]);
  });

  it("detects cycles and self-references and refuses to order them", () => {
    const cyc = [e("x_y", "s.x", "s.y"), e("y_x", "s.y", "s.x")];
    expect(findCycles(["s.x", "s.y"], cyc)).toEqual([["s.x", "s.y"]]);
    expect(() => deletionOrder(["s.x", "s.y"], cyc)).toThrow(/cycle/);
    expect(findCycles(["s.t"], [e("t_t", "s.t", "s.t")])).toEqual([["s.t"]]);
  });

  it("graph hash is order-independent and changes with ON DELETE", () => {
    expect(graphHash(edges)).toBe(graphHash([...edges].reverse()));
    expect(graphHash(edges)).not.toBe(graphHash([edges[0]!, edges[1]!, { ...edges[2]!, onDelete: "CASCADE" }]));
  });
});
