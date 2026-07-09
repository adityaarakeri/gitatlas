/**
 * Analysis tests. The barbell graph is the classic clustering testcase:
 * two dense cliques joined by one bridge edge must split into exactly two
 * neighborhoods, and doing it twice must give identical output.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { detectNeighborhoods, labelNeighborhoods, findHubs } from "../src/analyze.ts";

function clique(prefix: string, n: number) {
  const nodes = Array.from({ length: n }, (_, i) => `${prefix}${i}`);
  const edges = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    edges.push({ from: nodes[i], to: nodes[j] });
  }
  return { nodes, edges };
}

test("barbell graph splits into exactly two neighborhoods", () => {
  const a = clique("a", 5), b = clique("b", 5);
  const nodes = [...a.nodes, ...b.nodes];
  const edges = [...a.edges, ...b.edges, { from: "a0", to: "b0" }];
  const comm = detectNeighborhoods(nodes, edges);
  const groups = new Set(comm.values());
  assert.equal(groups.size, 2);
  // every a-node together, every b-node together
  const aComm = comm.get("a0");
  for (const n of a.nodes) assert.equal(comm.get(n), aComm);
  const bComm = comm.get("b0");
  for (const n of b.nodes) assert.equal(comm.get(n), bComm);
  assert.notEqual(aComm, bComm);
});

test("neighborhood detection is deterministic across runs", () => {
  const a = clique("a", 6), b = clique("b", 4), c = clique("c", 5);
  const nodes = [...a.nodes, ...b.nodes, ...c.nodes];
  const edges = [...a.edges, ...b.edges, ...c.edges,
    { from: "a0", to: "b0" }, { from: "b1", to: "c0" }];
  const r1 = detectNeighborhoods(nodes, edges);
  const r2 = detectNeighborhoods([...nodes].reverse(), edges);
  for (const n of nodes) assert.equal(r1.get(n), r2.get(n), `node ${n} stable regardless of input order`);
});

test("stable renumbering: community of the first sorted node is 0", () => {
  const a = clique("a", 4), z = clique("z", 4);
  const comm = detectNeighborhoods([...z.nodes, ...a.nodes], [...a.edges, ...z.edges]);
  assert.equal(comm.get("a0"), 0);
});

test("singleton and empty graphs do not explode", () => {
  assert.equal(detectNeighborhoods([], []).size, 0);
  const solo = detectNeighborhoods(["only"], []);
  assert.equal(solo.get("only"), 0);
});

test("labels use the deepest shared directory prefix", () => {
  const assignment = new Map([
    ["r:src/billing/invoice.ts", 0],
    ["r:src/billing/tax.ts", 0],
    ["r:src/auth/login.ts", 1],
    ["r:lib/util.ts", 1],
  ]);
  const labels = labelNeighborhoods(assignment, (id) => id.split(":")[1]);
  assert.equal(labels.get(0), "src/billing");
  // community 1 shares no prefix; falls back to most common top folder
  assert.ok(["src", "lib"].includes(labels.get(1)!));
});

test("hubs: star center flagged, leaves are not, tiny graphs produce none", () => {
  const leaves = Array.from({ length: 9 }, (_, i) => `leaf${i}`);
  const nodes = ["center", ...leaves];
  const edges = leaves.map((l) => ({ from: "center", to: l }));
  const { degree, hubs } = findHubs(nodes, edges);
  assert.equal(degree.get("center"), 9);
  assert.ok(hubs.has("center"));
  for (const l of leaves) assert.ok(!hubs.has(l));

  const tiny = findHubs(["a", "b", "c"], [{ from: "a", to: "b" }, { from: "b", to: "c" }]);
  assert.equal(tiny.hubs.size, 0, "no meaningless hubs on tiny graphs");
});

test("parallel edges count once for degree (distinct neighbors)", () => {
  const { degree } = findHubs(["a", "b"], [
    { from: "a", to: "b" }, { from: "a", to: "b" }, { from: "b", to: "a" },
  ]);
  assert.equal(degree.get("a"), 1);
});
