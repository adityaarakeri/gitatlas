import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

const CLI = path.resolve(import.meta.dirname, "../../../bin/gitatlas.js");
const LOCALES_DIR = path.resolve(import.meta.dirname, "../../viewer/locales");
const TEMPLATE = path.resolve(import.meta.dirname, "../../viewer/template.html");

type Value = string | Record<string, string>;
interface Catalog {
  locale: string;
  name: string;
  reviewed: boolean;
  maintainer: string | null;
  strings: Record<string, Value>;
}

function runCli(args: string[], timeout = 10_000): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ["--liftoff-only", CLI, ...args], {
    cwd: path.dirname(CLI),
    encoding: "utf8",
    timeout,
  });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function codes(): string[] {
  return fs.readdirSync(LOCALES_DIR).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort();
}
function load(code: string): Catalog {
  return JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, `${code}.json`), "utf8")) as Catalog;
}
function placeholders(value: Value): string[] {
  const texts = typeof value === "string" ? [value] : Object.values(value);
  const found = new Set<string>();
  for (const text of texts) for (const m of text.matchAll(/\{(\w+)\}/g)) found.add(m[1]);
  return [...found].sort();
}

const EN = load("en");
const OTHERS = codes().filter((c) => c !== "en");

test("en.json is the source catalog and the others are wave-one locales", () => {
  assert.ok(EN.reviewed, "English is the source text, so it is reviewed by definition");
  assert.deepEqual(OTHERS, ["es", "ja", "pt-BR", "zh-CN"]);
  for (const code of codes()) {
    const cat = load(code);
    assert.equal(cat.locale, code, `${code}.json: locale field must match the filename`);
    assert.ok(cat.name.length > 0, `${code}.json: needs a display name for the picker`);
    assert.equal(typeof cat.reviewed, "boolean", `${code}.json: reviewed must be a boolean`);
    // A locale is only shippable once a named human has signed off. Machine
    // drafts stay reviewed:false so the status table cannot overstate them.
    if (code !== "en" && cat.reviewed) {
      assert.ok(cat.maintainer, `${code}.json: reviewed:true requires a named maintainer`);
    }
  }
});

test("every catalog has exactly the English key set, with no empty strings", () => {
  const enKeys = Object.keys(EN.strings).sort();
  for (const code of OTHERS) {
    const cat = load(code);
    assert.deepEqual(Object.keys(cat.strings).sort(), enKeys,
      `${code}.json: key set drifted from en.json. A half-translated panel reads as a bug, so this is fatal.`);
    for (const [key, value] of Object.entries(cat.strings)) {
      const texts = typeof value === "string" ? [value] : Object.values(value);
      assert.ok(texts.length > 0, `${code}.json: ${key} has no text`);
      for (const text of texts) assert.ok(text.trim().length > 0, `${code}.json: ${key} is blank`);
    }
  }
});

test("plural entries and {placeholders} match English in every catalog", () => {
  for (const code of OTHERS) {
    const cat = load(code);
    for (const [key, enValue] of Object.entries(EN.strings)) {
      const value = cat.strings[key];
      assert.equal(typeof value === "object", typeof enValue === "object",
        `${code}.json: ${key} must be a plural map exactly where en.json is one`);
      if (typeof value === "object") {
        assert.ok(value.other, `${code}.json: ${key} needs an "other" category as the fallback`);
      }
      assert.deepEqual(placeholders(value), placeholders(enValue),
        `${code}.json: ${key} does not carry the same placeholders as en.json`);
    }
  }
});

test("plural maps only use categories the locale's Intl.PluralRules can select", () => {
  for (const code of codes()) {
    const cat = load(code);
    const allowed = new Set(new Intl.PluralRules(code).resolvedOptions().pluralCategories);
    for (const [key, value] of Object.entries(cat.strings)) {
      if (typeof value === "string") continue;
      for (const category of Object.keys(value)) {
        assert.ok(allowed.has(category as Intl.LDMLPluralRule),
          `${code}.json: ${key} declares "${category}", which ${code} never selects`);
      }
    }
  }
});

test("meta labels stay distinct inside each detail panel", () => {
  // the panel builds an object keyed by the translated label, so two labels
  // colliding in one group would drop a row instead of showing both
  const groups = {
    repo: ["meta.languages", "meta.modules", "meta.symbols", "meta.commit"],
    module: ["meta.path", "meta.symbols", "meta.lines", "meta.neighborhood", "meta.importDegree", "meta.hub"],
    symbol: ["meta.kind", "meta.line", "meta.exported", "meta.references"],
  };
  for (const code of codes()) {
    const cat = load(code);
    for (const [group, keys] of Object.entries(groups)) {
      const labels = keys.map((k) => cat.strings[k] as string);
      assert.equal(new Set(labels).size, labels.length,
        `${code}.json: the ${group} panel has two meta labels with the same text (${labels.join(", ")})`);
    }
  }
});

test("the template and en.json reference each other with no holes", () => {
  const html = fs.readFileSync(TEMPLATE, "utf8");
  const used = new Set<string>();
  for (const m of html.matchAll(/data-i18n(?:-aria|-ph)?="([^"]+)"/g)) used.add(m[1]);
  for (const m of html.matchAll(/\b(?:t|note)\("([^"]+)"/g)) used.add(m[1]);
  for (const m of html.matchAll(/key: "([^"]+)"/g)) used.add(m[1]);
  // t("kind." + kind) builds its key at runtime from a schema value
  assert.ok(html.includes('t("kind." + kind)'), "kindLabel should still build kind.* keys dynamically");

  for (const key of used) {
    if (key.endsWith(".")) continue; // the "kind." prefix of the dynamic lookup
    assert.ok(key in EN.strings, `template uses ${key}, which en.json does not define`);
  }
  // dead keys are checked by literal presence, so a new t() wrapper does not
  // silently turn every key it passes through into a false positive
  for (const key of Object.keys(EN.strings)) {
    if (key.startsWith("kind.")) continue; // reached only through kindLabel
    assert.ok(html.includes(`"${key}"`), `en.json defines ${key}, which the template never uses`);
  }
});

test("the viewer template still carries its English text inline", () => {
  // The generated file overwrites these from the active catalog, but keeping
  // them in the markup is what keeps the template readable on its own.
  const html = fs.readFileSync(TEMPLATE, "utf8");
  assert.match(html, /data-i18n="theme\.dark" aria-pressed="false">BARREL</);
  assert.match(html, /placeholder="Filter this level"/);
  assert.match(html, /\/\*__LOCALES__\*\/null/);
  assert.match(html, /\/\*__LANG__\*\/null/);
});

test("extract bakes every catalog into the map and --lang picks the default", { timeout: 120_000 }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gitatlas-i18n-"));
  const out = path.join(root, "map");
  try {
    const repoDir = path.join(root, "alpha");
    fs.mkdirSync(path.join(repoDir, ".git"), { recursive: true });
    fs.writeFileSync(path.join(repoDir, "index.ts"), "export function greet() { return 1; }\n");

    const bad = runCli(["extract", root, "--out", out, "--lang", "xx"], 60_000);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /unknown --lang xx/);
    assert.match(bad.stderr, /zh-CN/);

    const run = runCli(["extract", root, "--out", out, "--lang", "ja"], 60_000);
    assert.equal(run.status, 0, run.stderr);
    const html = fs.readFileSync(path.join(out, "index.html"), "utf8");
    assert.match(html, /window\.GITATLAS_LANG = "ja"/);
    // all four wave-one locales travel in the file, so a mixed-language team
    // can switch inside the one artifact they were emailed
    for (const code of codes()) assert.ok(html.includes(`"${code}"`), `${code} catalog missing from the map`);
    assert.ok(html.includes(load("ja").strings["parent.tree"] as string));

    // no --lang: the file auto-detects from the browser instead
    const auto = runCli(["extract", root, "--out", out], 60_000);
    assert.equal(auto.status, 0, auto.stderr);
    assert.match(fs.readFileSync(path.join(out, "index.html"), "utf8"), /window\.GITATLAS_LANG = null/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("UI copy never changes the graph data or the baked layout", { timeout: 120_000 }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gitatlas-i18n-layout-"));
  try {
    const repoDir = path.join(root, "alpha");
    fs.mkdirSync(path.join(repoDir, ".git"), { recursive: true });
    fs.writeFileSync(path.join(repoDir, "index.ts"), "export class A { run() { return 1; } }\n");

    const outEn = path.join(root, "map-en");
    const outJa = path.join(root, "map-ja");
    assert.equal(runCli(["extract", root, "--out", outEn, "--lang", "en"], 60_000).status, 0);
    assert.equal(runCli(["extract", root, "--out", outJa, "--lang", "ja"], 60_000).status, 0);

    // layout coordinates come from code structure, not from copy: the JSON on
    // both sides must be identical, schema values in English included.
    // generatedAt is the one wall-clock field and is expected to differ.
    const stamped = /"generatedAt": "[^"]*"/g;
    for (const file of fs.readdirSync(outEn).filter((f) => f.endsWith(".json"))) {
      const read = (dir: string) => fs.readFileSync(path.join(dir, file), "utf8").replace(stamped, '"generatedAt": ""');
      assert.equal(read(outJa), read(outEn),
        `${file} differs between locales; extract-time output must not depend on --lang`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
