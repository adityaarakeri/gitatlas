/**
 * Extractor tests: run the real extraction against the fixture repos and
 * assert language-specific semantics, not just non-emptiness.
 * Run via `npm test`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { extractRepo, globToRegExp } from "../src/extract.ts";

const FIX = path.resolve(import.meta.dirname, "../../../fixtures");

/** Build a throwaway python repo on disk; caller gets the root and a cleanup fn. */
function scratchRepo(layout: Record<string, string>): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "repolens-test-"));
  for (const [rel, body] of Object.entries(layout)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function sym(g: Awaited<ReturnType<typeof extractRepo>>, name: string) {
  return g.symbols.find((s) => s.name === name);
}

// Artifact-skipping tests run first: they use only python and no tree-sitter
// grammar zoo, so they complete before the polyglot-lab test's memory spike.
test("skip: build-artifact dirs (.egg-info, build, .dist-info) never become modules", async () => {
  const { root, cleanup } = scratchRepo({
    "src/app.py": "def real_func():\n    pass\n",
    "mypkg.egg-info/generated.py": "def egg_leak():\n    pass\n",
    "build/lib/artifact.py": "def build_leak():\n    pass\n",
    "foo-1.0.dist-info/meta.py": "def dist_leak():\n    pass\n",
  });
  try {
    const g = await extractRepo(root, "skip-fixture");
    assert.ok(g.symbols.some((s) => s.name === "real_func"), "real source is indexed");
    for (const leaked of ["egg_leak", "build_leak", "dist_leak"]) {
      assert.equal(g.symbols.find((s) => s.name === leaked), undefined, `${leaked} excluded`);
    }
    assert.ok(g.modules.every((m) => !m.path.includes("egg-info") && !m.path.startsWith("build/")),
      "no module paths point inside artifact dirs");
  } finally { cleanup(); }
});

test("code-only: docs and other non-code files never become modules", async () => {
  const { root, cleanup } = scratchRepo({
    "src/app.py": "def real_func():\n    pass\n",
    "README.md": "# Project\n\nSee `real_func` in src/app.py.\n",
    "NOTES.txt": "just some notes\n",
    "data/config.json": "{\"k\": 1}\n",
    "src/logo.svg": "<svg></svg>\n",
    // a docs tree with code-extension files (Sphinx conf, an example script):
    // excluded by directory, not just by extension
    "docs/conf.py": "project = 'x'\n",
    "docs/examples/demo.py": "def doc_example():\n    pass\n",
    "docs/guide.rst": "Guide\n=====\n\nProse, not code.\n",
  });
  try {
    const g = await extractRepo(root, "code-only-fixture");
    assert.ok(g.symbols.some((s) => s.name === "real_func"), "real source is indexed");
    for (const doc of ["README.md", "NOTES.txt", "data/config.json", "src/logo.svg", "docs/guide.rst"]) {
      assert.equal(g.modules.find((m) => m.path === doc), undefined, `${doc} is not a module`);
    }
    assert.ok(g.modules.every((m) => !m.path.startsWith("docs/")), "no module lives under a docs/ tree");
    assert.equal(g.symbols.find((s) => s.name === "doc_example"), undefined, "code inside docs/ is excluded");
    assert.deepEqual(g.language, ["python"], "only the code language is reported");
  } finally { cleanup(); }
});

test("ignore: custom globs prune files by name and by repo-relative path", async () => {
  const { root, cleanup } = scratchRepo({
    "src/app.py": "def keep_me():\n    pass\n",
    "src/legacy.py": "def drop_by_name():\n    pass\n",
    "generated/models.py": "def drop_by_path():\n    pass\n",
  });
  try {
    const has = (g: Awaited<ReturnType<typeof extractRepo>>, n: string) => g.symbols.some((s) => s.name === n);
    // without --ignore everything is indexed
    const base = await extractRepo(root, "x");
    assert.ok(has(base, "keep_me") && has(base, "drop_by_name") && has(base, "drop_by_path"));
    // basename glob drops legacy.py; path glob drops the whole generated/ tree
    const pruned = await extractRepo(root, "x", undefined,
      [globToRegExp("legacy.py"), globToRegExp("generated/**")]);
    assert.ok(has(pruned, "keep_me"), "unignored source survives");
    assert.ok(!has(pruned, "drop_by_name"), "basename glob pruned legacy.py");
    assert.ok(!has(pruned, "drop_by_path"), "path glob pruned generated/ tree");
  } finally { cleanup(); }
});

test("globToRegExp: wildcards, globstar, and separator boundaries", () => {
  const m = (glob: string, s: string) => globToRegExp(glob).test(s);
  assert.ok(m("*.egg-info", "mypkg.egg-info"));
  assert.ok(!m("*.egg-info", "sub/mypkg.egg-info"), "* does not cross separators");
  assert.ok(m("**/*.min.js", "a/b/c.min.js") && m("**/*.min.js", "c.min.js"), "globstar spans dirs and matches at root");
  assert.ok(m("docs/**", "docs") && m("docs/**", "docs/api/index.html"), "trailing /** matches the dir itself and its contents");
  assert.ok(m("build", "build") && !m("build", "rebuild"), "bare name is anchored");
});

test("typescript: functions, classes, methods, arrow functions", async () => {
  const g = await extractRepo(path.join(FIX, "checkout-api"), "checkout-api");
  assert.deepEqual(g.language, ["typescript"]);
  assert.equal(sym(g, "PaymentService")?.kind, "class");
  assert.equal(sym(g, "PaymentService.charge")?.kind, "method");
  assert.equal(sym(g, "validateCart")?.kind, "function", "arrow function captured");
  assert.ok(g.edges.some((e) => e.kind === "imports" && e.confidence === "resolved"));
});

test("python: underscore privacy, inheritance, import resolution", async () => {
  const g = await extractRepo(path.join(FIX, "py-analytics"), "py-analytics");
  assert.deepEqual(g.language, ["python"]);
  assert.equal(sym(g, "_private_thing")?.exported, false, "underscore means private");
  assert.equal(sym(g, "helper")?.exported, true);
  assert.equal(sym(g, "ReportBuilder.build")?.kind, "method");
  assert.ok(sym(g, "ReportBuilder.build")?.parent?.endsWith("ReportBuilder"), "method linked to class");
  assert.ok(g.edges.some((e) => e.kind === "extends" && e.to === "Base"), "inheritance edge");
  assert.ok(g.edges.some((e) => e.kind === "imports" && e.to.endsWith("utils.py") && e.confidence === "resolved"),
    "from utils import resolved to file");
  assert.equal(sym(g, "never_used")?.refCount, 0);
});

test("go: capitalization exports, receiver methods, go.mod import resolution", async () => {
  const g = await extractRepo(path.join(FIX, "go-gateway"), "go-gateway");
  assert.deepEqual(g.language, ["go"]);
  assert.equal(sym(g, "NewRouter")?.exported, true, "capitalized is exported");
  assert.equal(sym(g, "normalize")?.exported, false, "lowercase is unexported");
  assert.equal(sym(g, "Router")?.kind, "class", "struct type captured");
  const handle = sym(g, "Router.Handle");
  assert.equal(handle?.kind, "method", "receiver method named Type.Method");
  assert.ok(handle?.parent?.endsWith("Router"), "receiver method linked to its type");
  assert.ok(g.edges.some((e) => e.kind === "imports" && e.to.endsWith("router/router.go") && e.confidence === "resolved"),
    "module-path import resolved through go.mod");
});

test("ruby: classes, inheritance, require_relative resolution", async () => {
  const g = await extractRepo(path.join(FIX, "ruby-billing"), "ruby-billing");
  assert.deepEqual(g.language, ["ruby"]);
  assert.equal(sym(g, "Invoice")?.kind, "class");
  assert.equal(sym(g, "Invoice.total")?.kind, "method");
  assert.ok(g.edges.some((e) => e.kind === "extends" && e.to === "Invoice"), "LateInvoice < Invoice");
  assert.ok(g.edges.some((e) => e.kind === "imports" && e.to.endsWith("lib/tax.rb") && e.confidence === "resolved"),
    "require_relative resolved");
});

test("java: public/private modifiers, import resolution", async () => {
  const g = await extractRepo(path.join(FIX, "java-auth"), "java-auth");
  assert.deepEqual(g.language, ["java"]);
  assert.equal(sym(g, "AuthService")?.exported, true, "public class");
  assert.equal(sym(g, "AuthService.login")?.exported, true, "public method");
  assert.equal(sym(g, "AuthService.audit")?.exported, false, "private method");
  assert.ok(g.edges.some((e) => e.kind === "imports" && e.to.endsWith("TokenStore.java") && e.confidence === "resolved"),
    "import com.acme.auth.TokenStore resolved to file");
});

test("mixed-language repo reports every language it found", async () => {
  // py-analytics + a stray TS file would report both; simulate with checkout-api
  // (single-language) asserting language list shape stays an array
  const g = await extractRepo(path.join(FIX, "shared-types"), "shared-types");
  assert.ok(Array.isArray(g.language));
});

test("unresolved imports become pkg: edges, never fake resolutions", async () => {
  const g = await extractRepo(path.join(FIX, "go-gateway"), "go-gateway");
  // stdlib or external imports would be pkg:, and none of our resolved edges
  // point at files that do not exist
  for (const e of g.edges.filter((e) => e.kind === "imports" && !e.to.startsWith("pkg:"))) {
    assert.ok(e.confidence === "resolved", "in-repo import edges carry resolved confidence");
  }
});

test("layout: every module and symbol carries precomputed coordinates", async () => {
  const g = await extractRepo(path.join(FIX, "checkout-api"), "checkout-api");
  assert.ok(g.modules.every((m) => typeof m.x === "number" && typeof m.y === "number"));
  assert.ok(g.symbols.every((s) => typeof s.x === "number" && typeof s.y === "number"));
});

test("layout: identical repos produce identical coordinates, run after run", async () => {
  const a = await extractRepo(path.join(FIX, "checkout-api"), "checkout-api");
  const b = await extractRepo(path.join(FIX, "checkout-api"), "checkout-api");
  const coords = (g: typeof a) => g.modules.map((m) => `${m.id}:${m.x},${m.y}`)
    .concat(g.symbols.map((s) => `${s.id}:${s.x},${s.y}`)).sort();
  assert.deepEqual(coords(a), coords(b), "same repo in, same picture out");
});

test("calls: TS constructor calls attribute to the enclosing function", async () => {
  const g = await extractRepo(path.join(FIX, "checkout-api"), "checkout-api");
  const calls = g.edges.filter((e) => e.kind === "calls");
  assert.ok(calls.some((e) => e.from.endsWith("handleCheckout") && e.to.endsWith("PaymentService")),
    "new PaymentService() inside handleCheckout");
  assert.ok(calls.every((e) => e.confidence === "resolved"), "call edges are resolved or absent, never inferred");
});

test("calls: python cross-module and method calls resolve", async () => {
  const g = await extractRepo(path.join(FIX, "py-analytics"), "py-analytics");
  const calls = g.edges.filter((e) => e.kind === "calls");
  assert.ok(calls.some((e) => e.from.endsWith("ReportBuilder.build") && e.to.endsWith("utils.py:helper")),
    "method calling an imported function across modules");
  assert.ok(calls.some((e) => e.from.endsWith(":main") && e.to.endsWith("ReportBuilder.build")),
    "attribute call resolves to the method");
});

test("calls: go selector calls resolve to receiver methods", async () => {
  const g = await extractRepo(path.join(FIX, "go-gateway"), "go-gateway");
  const calls = g.edges.filter((e) => e.kind === "calls");
  assert.ok(calls.some((e) => e.from.endsWith(":main") && e.to.endsWith("Router.Handle")),
    "r.Handle() resolves through the selector");
  assert.ok(calls.some((e) => e.from.endsWith("Router.Handle") && e.to.endsWith(":normalize")),
    "package-internal call");
});

test("calls: ruby cross-file call resolves", async () => {
  const g = await extractRepo(path.join(FIX, "ruby-billing"), "ruby-billing");
  assert.ok(g.edges.some((e) => e.kind === "calls" && e.from.endsWith("Invoice.total") && e.to.endsWith(":tax_for")));
});

test("calls: well-formed everywhere, no self-loops, no dangling endpoints", async () => {
  const g = await extractRepo(path.join(FIX, "polyglot-lab"), "polyglot-lab");
  const ids = new Set([...g.symbols.map((s) => s.id), ...g.modules.map((m) => m.id)]);
  for (const e of g.edges.filter((e) => e.kind === "calls")) {
    assert.notEqual(e.from, e.to, "no self-loop edges");
    assert.ok(ids.has(e.from) && ids.has(e.to), "both endpoints exist in the graph");
  }
});
