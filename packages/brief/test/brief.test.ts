/**
 * Brief tests: pure, synthetic graphs, no I/O. Assert determinism, budget
 * trimming (announced, never silent), repo filtering, and staleness flagging.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBrief, estimateTokens } from "../src/brief.ts";
import { RepoGraph } from "../../schema/src/types.ts";

function makeGraph(name: string): RepoGraph {
  const mod = (rel: string, extra: object) => ({
    id: `${name}:${rel}`, path: rel, repo: name, symbolCount: 2, loc: 40, ...extra,
  });
  return {
    schemaVersion: "0.1.0",
    repo: name,
    root: `/repos/${name}`,
    language: ["typescript"],
    generatedAt: "2026-01-02T03:04:05.000Z",
    modules: [
      mod("src/core.ts", { symbolCount: 4, hub: true, degree: 9, neighborhood: 0 }),
      mod("src/util.ts", { hub: false, degree: 2, neighborhood: 0 }),
      mod("src/billing/stripe.ts", { hub: false, degree: 1, neighborhood: 1 }),
    ],
    symbols: [
      { id: `${name}:src/billing/stripe.ts:charge`, name: "charge", kind: "function", module: `${name}:src/billing/stripe.ts`, line: 10, exported: true, refCount: 5 },
      { id: `${name}:src/core.ts:Invoice`, name: "Invoice", kind: "class", module: `${name}:src/core.ts`, line: 3, exported: true, refCount: 2 },
      { id: `${name}:src/util.ts:helper`, name: "helper", kind: "function", module: `${name}:src/util.ts`, line: 1, exported: false, refCount: 0 },
    ],
    edges: [
      { from: `${name}:src/util.ts`, to: `${name}:src/core.ts`, kind: "imports", confidence: "exact" },
    ],
    neighborhoodLabels: { "0": "src", "1": "billing" },
  };
}

test("brief: full detail is deterministic and carries hubs, neighborhoods, and exports with file:line", () => {
  const graphs = [makeGraph("alpha"), makeGraph("beta")];
  const a = buildBrief("lab", graphs);
  const b = buildBrief("lab", graphs);
  assert.equal(a.text, b.text, "same graphs, same brief");
  assert.equal(a.level, 5);
  assert.deepEqual(a.omitted, []);
  assert.match(a.text, /# lab: architecture brief/);
  assert.match(a.text, /2 repos, 6 modules, 6 symbols/);
  assert.match(a.text, /## alpha \(typescript\): 3 modules, 3 symbols/);
  assert.match(a.text, /hubs \(widest change ripple\): src\/core\.ts \(9 links\)/);
  assert.match(a.text, /neighborhoods .*: src \(2\), billing \(1\)/);
  assert.match(a.text, /largest modules: src\/core\.ts \(4\)/);
  assert.match(a.text, /charge \[function\] src\/billing\/stripe\.ts:10/);
  assert.doesNotMatch(a.text, /helper/, "unexported symbols stay out of key exports");
  assert.doesNotMatch(a.text, /trimmed to fit/);
});

test("brief: a tight budget trims detail sections and says so", () => {
  const graphs = [makeGraph("alpha"), makeGraph("beta")];
  const full = buildBrief("lab", graphs);
  const trimmed = buildBrief("lab", graphs, { budgetTokens: estimateTokens(full.text) - 1 });
  assert.ok(trimmed.level < 5, "detail level dropped");
  assert.ok(trimmed.omitted.includes("key exports"));
  assert.match(trimmed.text, /trimmed to fit the token budget: .*key exports.* omitted/);

  const minimal = buildBrief("lab", graphs, { budgetTokens: 1 });
  assert.equal(minimal.level, 1, "level 1 always emits, even over budget");
  assert.match(minimal.text, /## alpha/, "repo summaries survive any budget");
  assert.deepEqual(minimal.omitted, ["hubs", "neighborhoods", "largest modules", "key exports"]);
});

test("brief: repo filter narrows the digest; unknown repo is an error", () => {
  const graphs = [makeGraph("alpha"), makeGraph("beta")];
  const one = buildBrief("lab", graphs, { repo: "beta" });
  assert.match(one.text, /## beta/);
  assert.doesNotMatch(one.text, /## alpha/);
  assert.match(one.text, /1 repo, 3 modules/);
  assert.throws(() => buildBrief("lab", graphs, { repo: "gamma" }), /gamma.*not found/);
});

test("brief: stale repos are flagged inside the text, scoped to the selection", () => {
  const graphs = [makeGraph("alpha"), makeGraph("beta")];
  const flagged = buildBrief("lab", graphs, { staleRepos: ["beta"] });
  assert.match(flagged.text, /WARNING: the map is stale for beta/);
  const filtered = buildBrief("lab", graphs, { repo: "alpha", staleRepos: ["beta"] });
  assert.doesNotMatch(filtered.text, /WARNING/, "a stale repo outside the selection is not flagged");
});
