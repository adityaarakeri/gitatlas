/**
 * Tests for the scoper core. Node's built-in test runner, no dependencies.
 * Run: node --test --experimental-strip-types packages/scoper/test/scope.test.ts
 * (or via `npm test`, which wires the flags)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseTrace, resolveFrame, buildAdjacency, walkNeighborhood, rankSuspects, scope,
  type RepoGraph,
} from "../src/scope.ts";

// ── a small hand-built graph that mirrors the fixture shape ──
const graph: RepoGraph = {
  repo: "checkout-api",
  modules: [
    { id: "checkout-api:src/services/payment.ts", path: "src/services/payment.ts" },
    { id: "checkout-api:src/routes/checkout.ts", path: "src/routes/checkout.ts" },
    { id: "checkout-api:src/index.ts", path: "src/index.ts" },
  ],
  symbols: [
    { id: "checkout-api:src/services/payment.ts:PaymentService", name: "PaymentService", kind: "class", module: "checkout-api:src/services/payment.ts", line: 2, exported: true, refCount: 2 },
    { id: "checkout-api:src/services/payment.ts:PaymentService.charge", name: "PaymentService.charge", kind: "method", module: "checkout-api:src/services/payment.ts", line: 3, exported: false, refCount: 0, parent: "checkout-api:src/services/payment.ts:PaymentService" },
    { id: "checkout-api:src/services/payment.ts:PaymentService.refund", name: "PaymentService.refund", kind: "method", module: "checkout-api:src/services/payment.ts", line: 4, exported: false, refCount: 0, parent: "checkout-api:src/services/payment.ts:PaymentService" },
    { id: "checkout-api:src/routes/checkout.ts:handleCheckout", name: "handleCheckout", kind: "function", module: "checkout-api:src/routes/checkout.ts", line: 3, exported: true, refCount: 2 },
    { id: "checkout-api:src/index.ts:startServer", name: "startServer", kind: "function", module: "checkout-api:src/index.ts", line: 2, exported: true, refCount: 0 },
  ],
  edges: [
    { from: "checkout-api:src/routes/checkout.ts", to: "checkout-api:src/services/payment.ts", kind: "imports", confidence: "resolved" },
    { from: "checkout-api:src/index.ts", to: "checkout-api:src/routes/checkout.ts", kind: "imports", confidence: "resolved" },
  ],
};

test("parseTrace handles V8 frames with fn name and location", () => {
  const frames = parseTrace([
    "Error: boom",
    "    at PaymentService.charge (/app/src/services/payment.ts:3:11)",
    "    at handleCheckout (src/routes/checkout.ts:3:5)",
  ].join("\n"));
  assert.equal(frames.length, 2);
  assert.equal(frames[0].fnName, "PaymentService.charge");
  assert.equal(frames[0].file, "/app/src/services/payment.ts");
  assert.equal(frames[0].line, 3);
  assert.equal(frames[1].fnName, "handleCheckout");
});

test("parseTrace handles anonymous frames (location only)", () => {
  const frames = parseTrace("    at /app/src/index.ts:2:1");
  assert.equal(frames.length, 1);
  assert.equal(frames[0].fnName, undefined);
  assert.equal(frames[0].line, 2);
});

test("parseTrace ignores non-frame lines", () => {
  assert.equal(parseTrace("just some log\nnot a frame").length, 0);
});

test("resolveFrame: file+line+name lands exact on the method", () => {
  const r = resolveFrame({ fnName: "PaymentService.charge", file: "src/services/payment.ts", line: 3 }, graph);
  assert.equal(r.id, "checkout-api:src/services/payment.ts:PaymentService.charge");
  assert.equal(r.confidence, "exact");
});

test("resolveFrame: file+line without matching name resolves to nearest decl", () => {
  // line 5 in payment.ts, nearest declaration at or above is refund (line 4)
  const r = resolveFrame({ file: "src/services/payment.ts", line: 5 }, graph);
  assert.equal(r.id, "checkout-api:src/services/payment.ts:PaymentService.refund");
  assert.equal(r.confidence, "resolved");
});

test("resolveFrame: unique bare name resolves with inferred confidence", () => {
  const r = resolveFrame({ fnName: "handleCheckout" }, graph);
  assert.equal(r.id, "checkout-api:src/routes/checkout.ts:handleCheckout");
  assert.equal(r.confidence, "inferred");
});

test("resolveFrame: unknown frame returns null", () => {
  const r = resolveFrame({ fnName: "doesNotExist", file: "nope.ts", line: 1 }, graph);
  assert.equal(r.id, null);
});

test("buildAdjacency links methods to their class and imports both ways", () => {
  const adj = buildAdjacency(graph);
  const cls = "checkout-api:src/services/payment.ts:PaymentService";
  const method = "checkout-api:src/services/payment.ts:PaymentService.charge";
  assert.ok(adj.get(cls)!.has(method), "class connects to method");
  assert.ok(adj.get(method)!.has(cls), "method connects to class (undirected)");
  const routes = "checkout-api:src/routes/checkout.ts";
  const payment = "checkout-api:src/services/payment.ts";
  assert.ok(adj.get(routes)!.has(payment) && adj.get(payment)!.has(routes), "imports are undirected");
});

test("walkNeighborhood respects hop limit", () => {
  const adj = buildAdjacency(graph);
  const anchor = "checkout-api:src/services/payment.ts:PaymentService.charge";
  const { reached } = walkNeighborhood(anchor, adj, 1, 100);
  assert.equal(reached.get(anchor), 0);
  // 1 hop reaches the class, not symbols two hops away
  assert.equal(reached.get("checkout-api:src/services/payment.ts:PaymentService"), 1);
  assert.ok(!reached.has("checkout-api:src/routes/checkout.ts:handleCheckout"));
});

test("walkNeighborhood truncates at maxNodes", () => {
  const adj = buildAdjacency(graph);
  const anchor = "checkout-api:src/services/payment.ts:PaymentService.charge";
  const { reached, truncated } = walkNeighborhood(anchor, adj, 5, 2);
  assert.ok(reached.size <= 2);
  assert.equal(truncated, true);
});

test("rankSuspects orders by hop distance and is stable", () => {
  const adj = buildAdjacency(graph);
  const anchor = "checkout-api:src/services/payment.ts:PaymentService.charge";
  const { reached } = walkNeighborhood(anchor, adj, 3, 100);
  const ranked = rankSuspects(reached, graph);
  assert.equal(ranked[0].id, anchor, "anchor ranks first (hops 0)");
  assert.equal(ranked[0].hops, 0);
  for (let i = 1; i < ranked.length; i++) {
    assert.ok(ranked[i - 1].score >= ranked[i].score, "scores monotonically non-increasing");
  }
});

test("rankSuspects surfaces the unused-reference reason", () => {
  const adj = buildAdjacency(graph);
  const { reached } = walkNeighborhood("checkout-api:src/services/payment.ts:PaymentService.charge", adj, 0, 100);
  const ranked = rankSuspects(reached, graph);
  assert.ok(ranked[0].reasons.some((r) => r.includes("no references")));
});

test("scope end-to-end from a stack trace", () => {
  const trace = [
    "TypeError: cannot read 'total' of undefined",
    "    at PaymentService.charge (/app/src/services/payment.ts:3:11)",
    "    at handleCheckout (/app/src/routes/checkout.ts:3:5)",
  ].join("\n");
  const result = scope(trace, graph, { maxHops: 2, topK: 5 });
  assert.equal(result.anchor.resolved, "checkout-api:src/services/payment.ts:PaymentService.charge");
  assert.equal(result.anchor.confidence, "exact");
  assert.ok(result.suspects.length > 0 && result.suspects.length <= 5);
  assert.equal(result.suspects[0].hops, 0);
});

test("scope from a bare symbol name (no trace)", () => {
  const result = scope("handleCheckout", graph, {});
  assert.equal(result.anchor.resolved, "checkout-api:src/routes/checkout.ts:handleCheckout");
  assert.equal(result.anchor.confidence, "inferred");
});

test("scope returns empty result when nothing resolves", () => {
  const result = scope("at nothingHere (ghost.ts:9:9)", graph, {});
  assert.equal(result.anchor.resolved, null);
  assert.deepEqual(result.suspects, []);
});

test("scope falls back through trace frames until one resolves", () => {
  // first frame is in an unknown file, second is real: anchor should be the second
  const trace = [
    "    at someVendorThing (/node_modules/x/dist/y.ts:99:1)",
    "    at handleCheckout (/app/src/routes/checkout.ts:3:5)",
  ].join("\n");
  const result = scope(trace, graph, {});
  assert.equal(result.anchor.resolved, "checkout-api:src/routes/checkout.ts:handleCheckout");
});
