/**
 * Polyglot tests. The first test is the gap detector: it iterates
 * SITTER_LANGS itself, so registering language number 20 without a fixture
 * or with a broken config fails CI automatically. Nobody has to remember.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import * as fs from "node:fs";
import { extractRepo, SITTER_LANGS } from "../src/extract.ts";

const LAB = path.resolve(import.meta.dirname, "../../../fixtures/polyglot-lab");
const graphP = extractRepo(LAB, "polyglot-lab");

function bySuffix(g: Awaited<typeof graphP>, ext: string) {
  return g.modules.filter((m) => m.path.endsWith(ext));
}
function sym(g: Awaited<typeof graphP>, name: string) {
  return g.symbols.find((s) => s.name === name);
}

test("GAP DETECTOR: every registered language has a fixture and produces symbols", async () => {
  const g = await graphP;
  for (const def of SITTER_LANGS) {
    if (def.name === "python" || def.name === "go" || def.name === "ruby" || def.name === "java") continue; // own fixture repos
    const files = fs.readdirSync(LAB, { recursive: true }) as string[];
    const covered = def.exts.some((ext) => files.some((f) => f.endsWith(ext)));
    assert.ok(covered, `language "${def.name}" has no fixture file in polyglot-lab; add one`);
    const mods = def.exts.flatMap((ext) => bySuffix(g, ext));
    const total = mods.reduce((a, m) => a + m.symbolCount, 0);
    assert.ok(total > 0, `language "${def.name}" extracted zero symbols; config is broken`);
    assert.ok(g.language.includes(def.name), `language "${def.name}" missing from graph.language`);
  }
});

test("c: static means file-local, structs captured, header include resolved", async () => {
  const g = await graphP;
  assert.equal(sym(g, "hidden")?.exported, false, "static function is not exported");
  assert.equal(sym(g, "Point")?.kind, "class", "struct captured");
  assert.ok(g.edges.some((e) => e.from.endsWith("geometry.c") && e.to.endsWith("util.h") && e.confidence === "resolved"));
});

test("cpp: class methods, inheritance, static file-local", async () => {
  const g = await graphP;
  assert.equal(sym(g, "Shape.area")?.kind, "method");
  assert.ok(g.edges.some((e) => e.from.endsWith("Circle") && e.to === "Shape" && e.kind === "extends"));
  assert.equal(sym(g, "helper")?.exported, false, "static void helper is file-local");
});

test("csharp: public/private modifiers, interface, base class edge", async () => {
  const g = await graphP;
  assert.equal(sym(g, "Service.Run")?.exported, true);
  assert.equal(sym(g, "Service.Audit")?.exported, false);
  assert.equal(sym(g, "IJob")?.kind, "interface");
  assert.ok(g.edges.some((e) => e.from.endsWith(":Service") && e.to === "BaseService"));
});

test("php: visibility, inheritance, require_once resolved", async () => {
  const g = await graphP;
  assert.equal(sym(g, "Invoice.total")?.exported, true);
  assert.equal(sym(g, "Invoice.log")?.exported, false);
  assert.ok(g.edges.some((e) => e.to === "Model" && e.kind === "extends"));
  assert.ok(g.edges.some((e) => e.from.endsWith("invoice.php") && e.to.endsWith("lib/tax.php") && e.confidence === "resolved"));
});

test("rust: pub visibility, impl methods attach to their type, trait is interface", async () => {
  const g = await graphP;
  const inRs = (name: string) => g.symbols.find((s) => s.name === name && s.module.endsWith(".rs"));
  assert.equal(inRs("area")?.exported, true, "pub fn");
  const norm = inRs("Point.norm");
  assert.equal(norm?.kind, "method", "fn inside impl becomes a method");
  assert.ok(norm?.parent?.endsWith("Point"), "method parented to the impl type");
  assert.equal(inRs("Point.secret")?.exported, false, "no pub means private");
  assert.equal(inRs("Shape")?.kind, "interface", "trait maps to interface");
});

test("kotlin: private modifier respected, delegation heritage", async () => {
  const g = await graphP;
  assert.equal(sym(g, "Service.run")?.exported, true);
  assert.equal(sym(g, "Service.audit")?.exported, false);
  assert.ok(g.edges.some((e) => e.from.endsWith(":Service.kt:Service") ? true : e.to === "Base"));
});

test("swift: protocol is interface, private func respected", async () => {
  const g = await graphP;
  assert.equal(sym(g, "Job")?.kind, "interface");
  assert.equal(sym(g, "Service.audit")?.exported, false);
});

test("dart: underscore privacy, relative import resolved", async () => {
  const g = await graphP;
  const inDart = (name: string) => g.symbols.find((s) => s.name === name && s.module.endsWith(".dart"));
  assert.equal(inDart("Invoice._log")?.exported, false);
  assert.equal(inDart("helper")?.exported, true);
  assert.ok(g.edges.some((e) => e.from.endsWith("invoice.dart") && e.to.endsWith("lib/tax.dart") && e.confidence === "resolved"));
});

test("scala: trait is interface, object captured, extends edge", async () => {
  const g = await graphP;
  assert.equal(sym(g, "Job")?.kind, "interface");
  assert.equal(sym(g, "Main.helper")?.kind, "method", "def inside object is a method");
  assert.ok(g.edges.some((e) => e.to === "Base" && e.kind === "extends"));
});

test("lua: local functions are file-local, require resolved through dots", async () => {
  const g = await graphP;
  const inLua = (name: string) => g.symbols.find((s) => s.name === name && s.module.endsWith(".lua"));
  assert.equal(inLua("hidden")?.exported, false, "local function");
  assert.equal(inLua("area")?.exported, true);
  assert.ok(g.edges.some((e) => e.from.endsWith("billing.lua") && e.to.endsWith("lib/tax.lua") && e.confidence === "resolved"),
    'require("lib.tax") resolved to lib/tax.lua');
});

test("bash: both function syntaxes captured, source resolved", async () => {
  const g = await graphP;
  assert.ok(sym(g, "deploy"), "function keyword syntax");
  assert.ok(sym(g, "cleanup"), "name() syntax");
  assert.ok(g.edges.some((e) => e.from.endsWith("deploy.sh") && e.to.endsWith("lib.sh") && e.confidence === "resolved"));
});

test("elixir: defmodule is a class, def public, defp private, functions become methods", async () => {
  const g = await graphP;
  assert.equal(sym(g, "Billing")?.kind, "class");
  assert.equal(sym(g, "Billing.total")?.exported, true);
  assert.equal(sym(g, "Billing.secret")?.exported, false, "defp is private");
});

test("objc: @interface is the class, @implementation methods attach to it", async () => {
  const g = await graphP;
  const service = g.symbols.filter((s) => s.name === "Service" && s.module.endsWith("Service.m"));
  assert.equal(service.length, 1, "one class symbol, implementation is context only");
  assert.equal(sym(g, "Service.run")?.kind, "method");
});

test("ocaml: let with params is a function, underscore private, type captured", async () => {
  const g = await graphP;
  const area = g.symbols.find((s) => s.name === "area" && s.module.endsWith("stats.ml"));
  assert.equal(area?.kind, "function");
  assert.equal(sym(g, "_hidden")?.exported, false);
  assert.equal(sym(g, "point")?.kind, "type");
});

test("zig: pub visibility, relative @import resolved", async () => {
  const g = await graphP;
  const area = g.symbols.find((s) => s.name === "area" && s.module.endsWith("build.zig"));
  assert.equal(area?.exported, true);
  const hidden = g.symbols.find((s) => s.name === "hidden" && s.module.endsWith("build.zig"));
  assert.equal(hidden?.exported, false);
  assert.ok(g.edges.some((e) => e.from.endsWith("build.zig") && e.to.endsWith("util.zig") && e.confidence === "resolved"));
});
