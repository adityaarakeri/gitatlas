/**
 * Extraction library. Two engines, one output shape:
 *   - TypeScript/JavaScript through the TypeScript compiler API (pure JS)
 *   - Python, Java, Ruby, Go through tree-sitter WASM grammars (no native builds)
 *
 * Every engine emits the same RepoGraph pieces. The per-language knowledge
 * lives in small config objects (SITTER_LANGS); the walking, counting, and
 * merging is shared.
 */
import * as ts from "typescript";
import { detectNeighborhoods, labelNeighborhoods, findHubs } from "../../analysis/src/analyze.js";
import { computeLayout, neighborhoodAnchors } from "./layout.js";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export const SCHEMA_VERSION = "0.1.0";
export const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", "coverage",
  ".gitnexus", ".archigraph", "vendor", "__pycache__", ".venv", "venv",
  "target", ".gradle", ".bundle", "htmlcov", "site-packages",
]);
// Artifact dirs whose names carry the package name as a prefix, so an exact
// match in SKIP_DIRS can't catch them (e.g. mypackage.egg-info, foo-1.0.dist-info).
export const SKIP_DIR_SUFFIXES = [".egg-info", ".dist-info", ".egg"];

// Documentation trees. These often hold code-extension files that aren't
// application code -- Sphinx's docs/conf.py, example scripts, a docs-site's
// JS/TS -- so the extension allowlist alone can't keep them out of the graph.
// Skipped by name at any depth to keep the map code-only. Pass a real source
// tree that happens to be named `docs` via a differently-named dir if needed.
export const DOC_DIRS = new Set(["docs", "doc"]);

/** A directory is skipped if it is dot-prefixed, an artifact/doc name, or an artifact suffix. */
export function shouldSkipDir(name: string): boolean {
  return name.startsWith(".")
    || SKIP_DIRS.has(name)
    || DOC_DIRS.has(name)
    || SKIP_DIR_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

/**
 * Compile a shell-style glob to an anchored RegExp. Supports `*` (any run of
 * non-separator chars), `?` (one non-separator char), and `**` (any run,
 * separators included). A trailing `/​**` also matches the bare directory,
 * so `docs/**` skips `docs` itself and everything under it.
 */
export function globToRegExp(glob: string): RegExp {
  const escapeSpecial = (c: string) => c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  let re = "";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === "/" && glob.slice(i + 1) === "**") { re += "(?:/.*)?"; i = glob.length; }
    else if (c === "*" && glob[i + 1] === "*") {
      i += 2;
      if (glob[i] === "/") { re += "(?:.*/)?"; i++; } else re += ".*";
    } else if (c === "*") { re += "[^/]*"; i++; }
    else if (c === "?") { re += "[^/]"; i++; }
    else { re += escapeSpecial(c); i++; }
  }
  return new RegExp("^" + re + "$");
}

/** Repo-relative walk pruning: a name or rel path matching any glob is skipped. */
export interface WalkIgnore { root: string; globs: RegExp[]; }
function matchesIgnore(name: string, rel: string, ignore: WalkIgnore): boolean {
  return ignore.globs.some((re) => re.test(name) || re.test(rel));
}

export interface SymbolNode {
  id: string; name: string; kind: string; module: string;
  line: number; exported: boolean; refCount?: number; parent?: string;
  x?: number; y?: number;
}
export interface ModuleNode {
  id: string; path: string; repo: string; symbolCount: number; loc: number;
  /** neighborhood id from deterministic modularity clustering */
  neighborhood?: number;
  /** distinct import neighbors */
  degree?: number;
  /** unusually high degree: where changes ripple widest */
  hub?: boolean;
  /** precomputed deterministic layout position */
  x?: number; y?: number;
}
export interface Edge { from: string; to: string; kind: string; confidence: string; }
export interface RepoGraph {
  schemaVersion: string; repo: string; root: string; language: string[];
  generatedAt: string; modules: ModuleNode[]; symbols: SymbolNode[]; edges: Edge[];
  /** neighborhood id -> human label (deepest shared directory) */
  neighborhoodLabels?: Record<string, string>;
  /** content hash of every file that entered this graph; see fingerprintFiles */
  sourceFingerprint?: string;
}

const TS_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

// ── shared helpers ──────────────────────────────────────────────

export function walk(dir: string, files: string[] = [], exclude?: Set<string>, ignore?: WalkIgnore): string[] {
  // sorted: readdir order is OS-dependent, and layout determinism depends on file order
  const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const rel = ignore ? path.relative(ignore.root, full).split(path.sep).join("/") : "";
    if (ignore && matchesIgnore(entry.name, rel, ignore)) continue;
    if (entry.isDirectory()) {
      if (!shouldSkipDir(entry.name) && !exclude?.has(path.resolve(full))) {
        walk(full, files, exclude, ignore);
      }
    } else if (isCodeFile(entry.name)) {
      // code-only by construction: docs (.md/.rst/.txt), data, and assets have
      // no language engine and never enter the graph. See CODE_EXTS.
      files.push(full);
    }
  }
  return files;
}

/**
 * One hash over the exact file set a walk produced: sha256 of the sorted
 * (repo-relative path, content sha256) pairs. Content-based on purpose:
 * mtimes differ across clones and machines, file bytes do not, so the same
 * source tree fingerprints identically anywhere. Any edit, addition, or
 * removal of an indexed file changes it, which is what `gitatlas check`
 * compares to call a graph stale.
 */
export function fingerprintFiles(repoRoot: string, files: string[]): string {
  const entries = files
    .map((abs) => ({ abs, rel: path.relative(repoRoot, abs).split(path.sep).join("/") }))
    .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const h = crypto.createHash("sha256");
  for (const { abs, rel } of entries) {
    h.update(rel);
    h.update("\0");
    h.update(crypto.createHash("sha256").update(fs.readFileSync(abs)).digest());
  }
  return "sha256:" + h.digest("hex");
}

interface RawCall { from: string; callee: string; }
interface Acc {
  modules: ModuleNode[]; symbols: SymbolNode[]; edges: Edge[];
  identCount: Map<string, number>; declCount: Map<string, number>;
  bareNames: Map<string, string>;
  rawCalls: RawCall[];
}
function newAcc(): Acc {
  return { modules: [], symbols: [], edges: [], identCount: new Map(), declCount: new Map(), bareNames: new Map(), rawCalls: [] };
}
function addSymbolTo(acc: Acc, moduleId: string, name: string, kind: string, line: number, exported: boolean, parent?: string) {
  acc.symbols.push({ id: `${moduleId}:${name}`, name, kind, module: moduleId, line, exported, parent });
  const bare = name.includes(".") ? name.split(".").pop()! : name;
  acc.bareNames.set(`${moduleId}:${name}`, bare);
  acc.declCount.set(bare, (acc.declCount.get(bare) ?? 0) + 1);
}
function finishRefCounts(acc: Acc) {
  for (const sym of acc.symbols) {
    const bare = acc.bareNames.get(sym.id)!;
    const refs = (acc.identCount.get(bare) ?? 0) - (acc.declCount.get(bare) ?? 0);
    sym.refCount = Math.max(0, refs);
  }
}

// ── engine 1: TypeScript / JavaScript ───────────────────────────

function isExportedTs(node: ts.Node): boolean {
  const mods = (node as { modifiers?: ts.NodeArray<ts.ModifierLike> }).modifiers;
  return !!mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

function extractTs(files: string[], repoRoot: string, repoName: string): Acc {
  const acc = newAcc();
  for (const file of files) {
    const rel = path.relative(repoRoot, file).split(path.sep).join("/");
    const moduleId = `${repoName}:${rel}`;
    const text = fs.readFileSync(file, "utf8");
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    let symbolCount = 0;
    const line = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;
    const add = (name: string, kind: string, n: ts.Node, exported: boolean, parent?: string) => {
      addSymbolTo(acc, moduleId, name, kind, line(n), exported, parent);
      symbolCount++;
    };
    const calleeOf = (expr: ts.Expression): string | null => {
      if (ts.isIdentifier(expr)) return expr.text;
      if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
      return null;
    };
    const visit = (node: ts.Node, cur: string | null) => {
      let nextCur = cur;
      if (ts.isFunctionDeclaration(node) && node.name) {
        add(node.name.text, "function", node, isExportedTs(node));
        nextCur = `${moduleId}:${node.name.text}`;
      } else if (ts.isClassDeclaration(node) && node.name) {
        const className = node.name.text;
        add(className, "class", node, isExportedTs(node));
        const classId = `${moduleId}:${className}`;
        nextCur = classId;
        for (const member of node.members) {
          if (ts.isMethodDeclaration(member) && member.name && ts.isIdentifier(member.name)) {
            add(`${className}.${member.name.text}`, "method", member, false, classId);
          }
        }
        for (const heritage of node.heritageClauses ?? []) {
          const kind = heritage.token === ts.SyntaxKind.ExtendsKeyword ? "extends" : "implements";
          for (const t of heritage.types) {
            acc.edges.push({ from: classId, to: t.expression.getText(sf), kind, confidence: "inferred" });
          }
        }
      } else if (ts.isMethodDeclaration(node) && node.name && ts.isIdentifier(node.name) && cur) {
        // descend into a method body attributing calls to the method itself
        const methodId = `${cur}.${node.name.text}`;
        if (acc.symbols.some((sy) => sy.id === methodId)) nextCur = methodId;
      } else if (ts.isInterfaceDeclaration(node)) {
        add(node.name.text, "interface", node, isExportedTs(node));
      } else if (ts.isTypeAliasDeclaration(node)) {
        add(node.name.text, "type", node, isExportedTs(node));
      } else if (ts.isEnumDeclaration(node)) {
        add(node.name.text, "enum", node, isExportedTs(node));
      } else if (ts.isVariableStatement(node)) {
        const exported = isExportedTs(node);
        for (const decl of node.declarationList.declarations) {
          if (ts.isIdentifier(decl.name) && decl.initializer &&
              (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))) {
            add(decl.name.text, "function", decl, exported);
          }
        }
      } else if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const spec = node.moduleSpecifier.text;
        let resolved: string | null = null;
        if (spec.startsWith(".")) {
          const base = path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec));
          const candidates = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
            "/index.ts", "/index.tsx", "/index.js", "/index.jsx"].map((ext) => base + ext);
          // ESM-style "./x.js" in TS source points at "./x.ts" on disk
          if (/\.jsx?$/.test(base)) candidates.push(base.replace(/\.js$/, ".ts").replace(/\.jsx$/, ".tsx"));
          for (const cand of candidates) {
            // only files the extractor indexes can be targets; an edge to
            // "./globals.css" would dangle (no module ever exists for it)
            if (TS_EXTS.has(path.posix.extname(cand)) && fs.existsSync(path.join(repoRoot, cand))) {
              resolved = cand;
              break;
            }
          }
        }
        if (resolved) {
          acc.edges.push({ from: moduleId, to: `${repoName}:${resolved}`, kind: "imports", confidence: "resolved" });
        } else {
          acc.edges.push({ from: moduleId, to: `pkg:${spec}`, kind: "imports", confidence: "exact" });
        }
      }
      // arrow functions: attribute their body's calls to the variable symbol
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer &&
          (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
        const fnId = `${moduleId}:${node.name.text}`;
        if (acc.symbols.some((sy) => sy.id === fnId)) nextCur = fnId;
      }
      if (ts.isCallExpression(node)) {
        const callee = calleeOf(node.expression);
        if (callee) acc.rawCalls.push({ from: nextCur ?? moduleId, callee });
      } else if (ts.isNewExpression(node) && node.expression && ts.isIdentifier(node.expression)) {
        acc.rawCalls.push({ from: nextCur ?? moduleId, callee: node.expression.text });
      }
      if (ts.isIdentifier(node)) {
        acc.identCount.set(node.text, (acc.identCount.get(node.text) ?? 0) + 1);
      }
      ts.forEachChild(node, (c) => visit(c, nextCur));
    };
    visit(sf, null);

    acc.modules.push({ id: moduleId, path: rel, repo: repoName, symbolCount, loc: text.split("\n").length });
  }
  finishRefCounts(acc);
  return acc;
}

// ── engine 2: tree-sitter (15 languages via WASM grammars) ──────

type SitterNode = {
  type: string; text: string; namedChildren: SitterNode[]; children: SitterNode[];
  startPosition: { row: number };
  childForFieldName(field: string): SitterNode | null;
  descendantsOfType(types: string | string[]): SitterNode[];
};

interface MatchResult { name: string; kind: string; exported: boolean; }

interface LangDef {
  name: string;
  exts: string[];
  wasm: string;
  idTypes: string[];
  /** node types that declare a function (or method, when inside a class ctx) */
  fnTypes: string[];
  /** node types that declare a class-like container and a symbol */
  classTypes: string[];
  classKind?: (n: SitterNode) => string;
  /** reject class-type nodes that are references, not declarations */
  classGuard?: (n: SitterNode) => boolean;
  nameOf: (n: SitterNode) => string | null;
  exported: (name: string, n: SitterNode) => boolean;
  heritage?: (n: SitterNode) => string[];
  /** methods declared outside the class body (Go receivers) */
  receiverOf?: (n: SitterNode) => string | null;
  /** sets method context WITHOUT declaring a symbol (Rust impl, ObjC @implementation) */
  containerOf?: (n: SitterNode) => string | null;
  /** fully custom matcher for grammars where declarations are not distinct node types */
  match?: (n: SitterNode) => MatchResult | null;
  imports: (root: SitterNode) => string[];
  /** regex fallback for grammars whose scanner mis-parses real-world imports */
  textImports?: (text: string) => string[];
  /** call recognition: call-expression node types plus a callee-name reader */
  calls?: { types: string[]; callee: (n: SitterNode) => string | null };
  resolve: (spec: string, moduleRel: string, ctx: ResolveCtx) => string | null;
}
interface ResolveCtx { repoRoot: string; relFiles: string[]; relSet: Set<string>; goModule?: string; }

const nameField = (n: SitterNode) => n.childForFieldName("name")?.text ?? null;
const firstOfType = (n: SitterNode, types: string[]) => n.descendantsOfType(types)[0]?.text ?? null;
/** C-family: drill the declarator chain to the function's own identifier */
function cDeclName(n: SitterNode): string | null {
  let d = n.childForFieldName("declarator");
  while (d && d.type !== "identifier" && d.type !== "field_identifier") {
    d = d.childForFieldName("declarator") ?? d.namedChildren[0] ?? null;
  }
  return d?.text ?? null;
}
function hasChildOfType(n: SitterNode, type: string, text?: string): boolean {
  return n.children.some((c) => c.type === type && (text == null || c.text.includes(text)));
}
/** resolve a relative-looking path against the importing module's dir, then repo root */
function resolveRelative(spec: string, moduleRel: string, ctx: ResolveCtx, exts: string[]): string | null {
  const clean = spec.replace(/^["']|["']$/g, "");
  const bases = [path.posix.dirname(moduleRel), ""];
  for (const base of bases) {
    for (const ext of ["", ...exts]) {
      const cand = path.posix.normalize(path.posix.join(base, clean + ext));
      if (ctx.relSet.has(cand)) return cand;
    }
  }
  // last resort: unique suffix match anywhere in the repo
  const tail = clean.split("/").pop()!;
  const hits = ctx.relFiles.filter((f) => f.endsWith("/" + tail) || f === tail);
  return hits.length === 1 ? hits[0] : null;
}

export const SITTER_LANGS: LangDef[] = [
  {
    name: "python", exts: [".py"], wasm: "tree-sitter-python",
    idTypes: ["identifier"],
    fnTypes: ["function_definition"], classTypes: ["class_definition"],
    nameOf: nameField,
    exported: (name) => !name.startsWith("_"),
    heritage: (n) => (n.childForFieldName("superclasses")?.descendantsOfType("identifier") ?? []).map((c) => c.text),
    calls: {
      types: ["call"],
      callee: (n) => {
        const f = n.childForFieldName("function");
        if (!f) return null;
        if (f.type === "identifier") return f.text;
        if (f.type === "attribute") return f.childForFieldName("attribute")?.text ?? null;
        return null;
      },
    },
    imports: (root) => {
      const specs: string[] = [];
      for (const n of root.descendantsOfType(["import_statement", "import_from_statement"])) {
        if (n.type === "import_statement") {
          for (const d of n.descendantsOfType("dotted_name")) specs.push(d.text);
        } else {
          const mod = n.childForFieldName("module_name");
          if (mod) specs.push(mod.text);
        }
      }
      return specs;
    },
    resolve: (spec, moduleRel, ctx) => {
      let base: string;
      let rest = spec;
      if (spec.startsWith(".")) {
        const dots = spec.match(/^\.+/)![0].length;
        rest = spec.slice(dots);
        base = moduleRel.split("/").slice(0, -dots).join("/");
      } else {
        base = "";
      }
      const p = (base ? base + "/" : "") + rest.replace(/\./g, "/");
      for (const cand of [p + ".py", p + "/__init__.py"]) {
        const norm = path.posix.normalize(cand);
        if (ctx.relSet.has(norm)) return norm;
      }
      return null;
    },
  },
  {
    name: "go", exts: [".go"], wasm: "tree-sitter-go",
    idTypes: ["identifier", "type_identifier", "field_identifier"],
    fnTypes: ["function_declaration", "method_declaration"], classTypes: ["type_spec"],
    classKind: (n) => (n.childForFieldName("type")?.type === "interface_type" ? "interface" : "class"),
    nameOf: nameField,
    exported: (name) => /^[A-Z]/.test(name),
    receiverOf: (n) =>
      n.type === "method_declaration"
        ? n.childForFieldName("receiver")?.descendantsOfType("type_identifier")[0]?.text ?? null
        : null,
    calls: {
      types: ["call_expression"],
      callee: (n) => {
        const f = n.childForFieldName("function");
        if (!f) return null;
        if (f.type === "identifier") return f.text;
        if (f.type === "selector_expression") return f.childForFieldName("field")?.text ?? null;
        return null;
      },
    },
    imports: (root) =>
      root.descendantsOfType("import_spec").map((n) =>
        (n.childForFieldName("path")?.text ?? "").replace(/^"|"$/g, "")).filter(Boolean),
    resolve: (spec, _moduleRel, ctx) => {
      if (!ctx.goModule) return null;
      if (spec !== ctx.goModule && !spec.startsWith(ctx.goModule + "/")) return null;
      const dir = spec === ctx.goModule ? "" : spec.slice(ctx.goModule.length + 1);
      const hit = ctx.relFiles.find((f) => f.endsWith(".go") &&
        (dir === "" ? !f.includes("/") : f.startsWith(dir + "/") && !f.slice(dir.length + 1).includes("/")));
      return hit ?? null;
    },
  },
  {
    name: "java", exts: [".java"], wasm: "tree-sitter-java",
    idTypes: ["identifier", "type_identifier"],
    fnTypes: ["method_declaration", "constructor_declaration"],
    classTypes: ["class_declaration", "interface_declaration", "enum_declaration"],
    classKind: (n) => (n.type === "interface_declaration" ? "interface" : n.type === "enum_declaration" ? "enum" : "class"),
    nameOf: nameField,
    exported: (_name, n) => hasChildOfType(n, "modifiers", "public"),
    heritage: (n) => {
      const out: string[] = [];
      const sc = n.childForFieldName("superclass");
      if (sc) out.push(...sc.descendantsOfType("type_identifier").map((x) => x.text));
      const ifc = n.childForFieldName("interfaces");
      if (ifc) out.push(...ifc.descendantsOfType("type_identifier").map((x) => x.text));
      return out;
    },
    calls: {
      types: ["method_invocation", "object_creation_expression"],
      callee: (n) =>
        n.type === "object_creation_expression"
          ? n.childForFieldName("type")?.text ?? null
          : n.childForFieldName("name")?.text ?? null,
    },
    imports: (root) =>
      root.descendantsOfType("import_declaration").map((n) =>
        n.descendantsOfType(["scoped_identifier", "identifier"])[0]?.text ?? "").filter(Boolean),
    resolve: (spec, _moduleRel, ctx) => {
      const tail = spec.replace(/\./g, "/") + ".java";
      return ctx.relFiles.find((f) => f.endsWith(tail)) ?? null;
    },
  },
  {
    name: "ruby", exts: [".rb"], wasm: "tree-sitter-ruby",
    idTypes: ["identifier", "constant"],
    fnTypes: ["method"], classTypes: ["class", "module"],
    classKind: (n) => (n.type === "module" ? "interface" : "class"),
    nameOf: (n) => n.childForFieldName("name")?.text ?? null,
    exported: () => true,
    heritage: (n) => {
      const sc = n.childForFieldName("superclass");
      return sc ? sc.descendantsOfType("constant").map((x) => x.text) : [];
    },
    calls: {
      types: ["call"],
      callee: (n) => {
        const m = n.childForFieldName("method")?.text ?? null;
        return m === "require" || m === "require_relative" ? null : m;
      },
    },
    imports: (root) => {
      const specs: string[] = [];
      for (const call of root.descendantsOfType("call")) {
        const m = call.childForFieldName("method")?.text;
        if (m === "require_relative" || m === "require") {
          const str = call.descendantsOfType("string_content")[0]?.text;
          if (str) specs.push((m === "require" ? "req:" : "rel:") + str);
        }
      }
      return specs;
    },
    resolve: (spec, moduleRel, ctx) => {
      const [mode, p] = [spec.slice(0, 4), spec.slice(4)];
      if (mode === "rel:") {
        const cand = path.posix.normalize(path.posix.join(path.posix.dirname(moduleRel), p) + ".rb");
        return ctx.relSet.has(cand) ? cand : null;
      }
      for (const cand of ["lib/" + p + ".rb", p + ".rb"]) {
        if (ctx.relSet.has(cand)) return cand;
      }
      return null;
    },
  },
  {
    name: "c", exts: [".c", ".h"], wasm: "tree-sitter-c",
    idTypes: ["identifier", "type_identifier", "field_identifier"],
    fnTypes: ["function_definition"], classTypes: ["struct_specifier"],
    classGuard: (n) => n.childForFieldName("body") != null,
    nameOf: (n) => (n.type === "struct_specifier" ? nameField(n) : cDeclName(n)),
    exported: (_name, n) => !hasChildOfType(n, "storage_class_specifier", "static"),
    calls: {
      types: ["call_expression"],
      callee: (n) => {
        const f = n.childForFieldName("function");
        if (!f) return null;
        if (f.type === "identifier") return f.text;
        if (f.type === "field_expression") return f.childForFieldName("field")?.text ?? null;
        if (f.type === "qualified_identifier") return f.childForFieldName("name")?.text ?? null;
        return null;
      },
    },
    imports: (root) =>
      root.descendantsOfType("preproc_include").map((n) =>
        n.childForFieldName("path")?.descendantsOfType("string_content")[0]?.text ??
        n.childForFieldName("path")?.text ?? "").filter(Boolean),
    resolve: (spec, moduleRel, ctx) =>
      spec.startsWith("<") ? null : resolveRelative(spec, moduleRel, ctx, []),
  },
  {
    name: "cpp", exts: [".cpp", ".cc", ".cxx", ".hpp", ".hh"], wasm: "tree-sitter-cpp",
    idTypes: ["identifier", "type_identifier", "field_identifier"],
    fnTypes: ["function_definition"], classTypes: ["class_specifier", "struct_specifier"],
    classGuard: (n) => n.childForFieldName("body") != null,
    nameOf: (n) => (n.type.endsWith("_specifier") ? nameField(n) : cDeclName(n)),
    exported: (_name, n) => !hasChildOfType(n, "storage_class_specifier", "static"),
    heritage: (n) =>
      n.namedChildren.filter((c) => c.type === "base_class_clause")
        .flatMap((c) => c.descendantsOfType("type_identifier").map((x) => x.text)),
    calls: {
      types: ["call_expression"],
      callee: (n) => {
        const f = n.childForFieldName("function");
        if (!f) return null;
        if (f.type === "identifier") return f.text;
        if (f.type === "field_expression") return f.childForFieldName("field")?.text ?? null;
        if (f.type === "qualified_identifier") return f.childForFieldName("name")?.text ?? null;
        return null;
      },
    },
    imports: (root) =>
      root.descendantsOfType("preproc_include").map((n) =>
        n.childForFieldName("path")?.descendantsOfType("string_content")[0]?.text ??
        n.childForFieldName("path")?.text ?? "").filter(Boolean),
    resolve: (spec, moduleRel, ctx) =>
      spec.startsWith("<") ? null : resolveRelative(spec, moduleRel, ctx, []),
  },
  {
    name: "csharp", exts: [".cs"], wasm: "tree-sitter-c_sharp",
    idTypes: ["identifier"],
    fnTypes: ["method_declaration", "constructor_declaration"],
    classTypes: ["class_declaration", "interface_declaration", "enum_declaration", "struct_declaration", "record_declaration"],
    classKind: (n) => (n.type === "interface_declaration" ? "interface" : n.type === "enum_declaration" ? "enum" : "class"),
    nameOf: nameField,
    exported: (_name, n) => hasChildOfType(n, "modifier", "public"),
    heritage: (n) =>
      (n.childForFieldName("bases")?.descendantsOfType("identifier") ?? []).map((x) => x.text),
    calls: {
      types: ["invocation_expression", "object_creation_expression"],
      callee: (n) => {
        if (n.type === "object_creation_expression") return n.childForFieldName("type")?.text ?? null;
        const f = n.childForFieldName("function");
        if (!f) return null;
        if (f.type === "identifier") return f.text;
        if (f.type === "member_access_expression") return f.childForFieldName("name")?.text ?? null;
        return null;
      },
    },
    imports: (root) =>
      root.descendantsOfType("using_directive").map((n) => n.text.replace(/^using\s+|;$/g, "").trim()),
    resolve: () => null, // namespaces do not map to file paths reliably
  },
  {
    name: "php", exts: [".php"], wasm: "tree-sitter-php",
    idTypes: ["name", "variable_name"],
    fnTypes: ["function_definition", "method_declaration"],
    classTypes: ["class_declaration", "interface_declaration", "trait_declaration", "enum_declaration"],
    classKind: (n) => (n.type === "interface_declaration" || n.type === "trait_declaration" ? "interface" : n.type === "enum_declaration" ? "enum" : "class"),
    nameOf: nameField,
    exported: (_name, n) =>
      n.type !== "method_declaration" || !hasChildOfType(n, "visibility_modifier", "private"),
    heritage: (n) =>
      n.namedChildren.filter((c) => c.type === "base_clause" || c.type === "class_interface_clause")
        .flatMap((c) => c.descendantsOfType("name").map((x) => x.text)),
    calls: {
      types: ["function_call_expression", "member_call_expression", "object_creation_expression"],
      callee: (n) =>
        n.childForFieldName("name")?.text ??
        (n.childForFieldName("function")?.type === "name" ? n.childForFieldName("function")!.text : null) ??
        firstOfType(n, ["name"]),
    },
    imports: (root) =>
      root.descendantsOfType(["require_once_expression", "require_expression", "include_expression", "include_once_expression"])
        .map((n) => n.descendantsOfType("string_content")[0]?.text ?? "").filter(Boolean),
    resolve: (spec, moduleRel, ctx) => resolveRelative(spec, moduleRel, ctx, [".php"]),
  },
  {
    name: "rust", exts: [".rs"], wasm: "tree-sitter-rust",
    idTypes: ["identifier", "type_identifier", "field_identifier"],
    fnTypes: ["function_item"],
    classTypes: ["struct_item", "enum_item", "trait_item"],
    classKind: (n) => (n.type === "trait_item" ? "interface" : n.type === "enum_item" ? "enum" : "class"),
    nameOf: nameField,
    exported: (_name, n) => hasChildOfType(n, "visibility_modifier"),
    containerOf: (n) =>
      n.type === "impl_item" ? n.childForFieldName("type")?.text ?? null : null,
    calls: {
      types: ["call_expression"],
      callee: (n) => {
        const f = n.childForFieldName("function");
        if (!f) return null;
        if (f.type === "identifier") return f.text;
        if (f.type === "field_expression") return f.childForFieldName("field")?.text ?? null;
        if (f.type === "scoped_identifier") return f.childForFieldName("name")?.text ?? null;
        return null;
      },
    },
    imports: (root) =>
      root.descendantsOfType("use_declaration").map((n) =>
        n.childForFieldName("argument")?.text ?? "").filter(Boolean),
    resolve: () => null, // rust module paths need mod-tree resolution; pkg: for now
  },
  {
    name: "kotlin", exts: [".kt", ".kts"], wasm: "tree-sitter-kotlin",
    idTypes: ["simple_identifier", "type_identifier"],
    fnTypes: ["function_declaration"],
    classTypes: ["class_declaration", "object_declaration"],
    nameOf: (n) => firstOfType(n, ["type_identifier", "simple_identifier"]),
    exported: (_name, n) =>
      !hasChildOfType(n, "modifiers", "private") && !hasChildOfType(n, "modifiers", "internal"),
    heritage: (n) =>
      n.namedChildren.filter((c) => c.type === "delegation_specifier")
        .flatMap((c) => c.descendantsOfType("type_identifier").map((x) => x.text)),
    calls: {
      types: ["call_expression"],
      callee: (n) => firstOfType(n, ["simple_identifier"]),
    },
    imports: (root) => root.descendantsOfType("import_header").map((n) => n.text.replace(/^import\s+/, "").trim()),
    resolve: () => null,
  },
  {
    name: "swift", exts: [".swift"], wasm: "tree-sitter-swift",
    idTypes: ["simple_identifier", "type_identifier"],
    fnTypes: ["function_declaration"],
    classTypes: ["class_declaration", "protocol_declaration"],
    classKind: (n) => (n.type === "protocol_declaration" ? "interface" : "class"),
    nameOf: (n) => n.childForFieldName("name")?.text ?? firstOfType(n, ["type_identifier", "simple_identifier"]),
    exported: (_name, n) =>
      !hasChildOfType(n, "modifiers", "private") && !hasChildOfType(n, "modifiers", "fileprivate"),
    heritage: (n) =>
      n.namedChildren.filter((c) => c.type === "inheritance_specifier")
        .flatMap((c) => c.descendantsOfType("type_identifier").map((x) => x.text)),
    imports: (root) => root.descendantsOfType("import_declaration").map((n) => n.text.replace(/^import\s+/, "").trim()),
    resolve: () => null,
  },
  {
    name: "dart", exts: [".dart"], wasm: "tree-sitter-dart",
    idTypes: ["identifier", "type_identifier"],
    fnTypes: ["function_signature", "method_signature"],
    classTypes: ["class_definition"],
    nameOf: (n) => (n.type === "method_signature" ? firstOfType(n, ["identifier"]) : nameField(n) ?? firstOfType(n, ["identifier"])),
    exported: (name) => !name.startsWith("_"),
    heritage: (n) =>
      (n.childForFieldName("superclass")?.descendantsOfType("type_identifier") ?? []).map((x) => x.text),
    imports: (root) =>
      root.descendantsOfType("import_specification").map((n) =>
        n.descendantsOfType("string_literal")[0]?.text.replace(/^['"]|['"]$/g, "") ?? "")
        .filter((s) => s && !s.startsWith("package:") && !s.startsWith("dart:")),
    resolve: (spec, moduleRel, ctx) => resolveRelative(spec, moduleRel, ctx, [".dart"]),
  },
  {
    name: "scala", exts: [".scala"], wasm: "tree-sitter-scala",
    idTypes: ["identifier", "type_identifier"],
    fnTypes: ["function_definition"],
    classTypes: ["class_definition", "object_definition", "trait_definition"],
    classKind: (n) => (n.type === "trait_definition" ? "interface" : "class"),
    nameOf: nameField,
    exported: (_name, n) => !n.text.startsWith("private"),
    heritage: (n) =>
      (n.childForFieldName("extend")?.descendantsOfType("type_identifier") ?? []).map((x) => x.text),
    imports: (root) => root.descendantsOfType("import_declaration").map((n) => n.text.replace(/^import\s+/, "").trim()),
    resolve: () => null,
  },
  {
    name: "lua", exts: [".lua"], wasm: "tree-sitter-lua",
    idTypes: ["identifier"],
    fnTypes: ["function_definition_statement", "local_function_definition_statement"],
    classTypes: [],
    nameOf: nameField,
    exported: (_name, n) => n.type !== "local_function_definition_statement",
    imports: (root) => {
      const specs: string[] = [];
      for (const call of root.descendantsOfType("call")) {
        if (call.childForFieldName("function")?.text === "require") {
          const s = call.descendantsOfType("string")[0]?.text.replace(/^["']|["']$/g, "");
          if (s) specs.push(s);
        }
      }
      return specs;
    },
    calls: {
      types: ["call"],
      callee: (n) => {
        const f = n.childForFieldName("function");
        const name = f?.type === "variable" ? f.childForFieldName("name")?.text ?? null : null;
        return name === "require" ? null : name;
      },
    },
    textImports: (text) =>
      [...text.matchAll(/require\s*\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]),
    resolve: (spec, moduleRel, ctx) =>
      resolveRelative(spec.replace(/\./g, "/"), moduleRel, ctx, [".lua", "/init.lua"]),
  },
  {
    name: "bash", exts: [".sh", ".bash"], wasm: "tree-sitter-bash",
    idTypes: ["word", "variable_name"],
    fnTypes: ["function_definition"],
    classTypes: [],
    nameOf: nameField,
    exported: () => true,
    imports: (root) => {
      const specs: string[] = [];
      for (const cmd of root.descendantsOfType("command")) {
        const name = cmd.childForFieldName("name")?.text;
        if (name === "source" || name === ".") {
          const arg = cmd.namedChildren.find((c) => c.type === "word" && c.text !== name)?.text
            ?? cmd.descendantsOfType("word")[1]?.text;
          if (arg) specs.push(arg);
        }
      }
      return specs;
    },
    resolve: (spec, moduleRel, ctx) => resolveRelative(spec, moduleRel, ctx, [".sh"]),
  },
  {
    name: "elixir", exts: [".ex", ".exs"], wasm: "tree-sitter-elixir",
    idTypes: ["identifier", "alias"],
    fnTypes: [], classTypes: [],
    nameOf: () => null,
    exported: () => true,
    match: (n) => {
      if (n.type !== "call") return null;
      const target = n.childForFieldName("target")?.text;
      const args = n.namedChildren.find((c) => c.type === "arguments");
      if (target === "defmodule") {
        const alias = args?.descendantsOfType("alias")[0]?.text;
        return alias ? { name: alias, kind: "class", exported: true } : null;
      }
      if (target === "def" || target === "defp") {
        const inner = args?.namedChildren.find((c) => c.type === "call");
        const fname = inner?.childForFieldName("target")?.text
          ?? args?.descendantsOfType("identifier")[0]?.text;
        return fname ? { name: fname, kind: "function", exported: target === "def" } : null;
      }
      return null;
    },
    calls: {
      types: ["call"],
      callee: (n) => {
        const t = n.childForFieldName("target")?.text ?? null;
        const skip = new Set(["def", "defp", "defmodule", "defimpl", "defprotocol", "import", "alias", "use", "require", "if", "unless", "case", "cond", "quote"]);
        return t && !skip.has(t) ? t : null;
      },
    },
    imports: (root) => {
      const specs: string[] = [];
      for (const call of root.descendantsOfType("call")) {
        const t = call.childForFieldName("target")?.text;
        if (t === "import" || t === "alias" || t === "use") {
          const a = call.descendantsOfType("alias")[0]?.text;
          if (a) specs.push(a);
        }
      }
      return specs;
    },
    resolve: () => null,
  },
  {
    name: "objc", exts: [".m", ".mm"], wasm: "tree-sitter-objc",
    idTypes: ["identifier", "field_identifier", "type_identifier"],
    fnTypes: ["method_definition", "function_definition"],
    classTypes: ["class_interface"],
    nameOf: (n) =>
      n.type === "class_interface" ? firstOfType(n, ["identifier"])
      : n.type === "method_definition" ? firstOfType(n, ["identifier"])
      : cDeclName(n),
    exported: () => true,
    heritage: (n) => {
      const sup = n.childForFieldName("superclass")?.text;
      return sup ? [sup] : [];
    },
    containerOf: (n) =>
      n.type === "class_implementation" ? firstOfType(n, ["identifier"]) : null,
    imports: (root) =>
      root.descendantsOfType("preproc_include").map((n) =>
        n.childForFieldName("path")?.descendantsOfType("string_content")[0]?.text ??
        n.childForFieldName("path")?.text ?? "").filter(Boolean),
    resolve: (spec, moduleRel, ctx) =>
      spec.startsWith("<") ? null : resolveRelative(spec, moduleRel, ctx, []),
  },
  {
    name: "ocaml", exts: [".ml", ".mli"], wasm: "tree-sitter-ocaml",
    idTypes: ["value_name", "type_constructor", "module_name"],
    fnTypes: [], classTypes: [],
    nameOf: () => null,
    exported: () => true,
    match: (n) => {
      if (n.type === "let_binding") {
        const name = n.childForFieldName("pattern")?.text;
        if (!name || !/^[A-Za-z_]/.test(name)) return null;
        const isFn = n.namedChildren.some((c) => c.type === "parameter");
        return { name, kind: isFn ? "function" : "variable", exported: !name.startsWith("_") };
      }
      if (n.type === "type_binding") {
        const name = nameField(n);
        return name ? { name, kind: "type", exported: true } : null;
      }
      return null;
    },
    imports: (root) => root.descendantsOfType("open_module").map((n) => n.text.replace(/^open\s+/, "").trim()),
    resolve: () => null,
  },
  {
    name: "zig", exts: [".zig"], wasm: "tree-sitter-zig",
    idTypes: ["identifier"],
    fnTypes: ["function_declaration"],
    classTypes: [],
    nameOf: nameField,
    exported: (_name, n) => n.text.startsWith("pub"),
    imports: (root) => {
      const specs: string[] = [];
      for (const b of root.descendantsOfType("builtin_function")) {
        if (b.descendantsOfType("builtin_identifier")[0]?.text === "@import") {
          const s = b.descendantsOfType("string_content")[0]?.text;
          if (s && s.endsWith(".zig")) specs.push(s);
        }
      }
      return specs;
    },
    resolve: (spec, moduleRel, ctx) => resolveRelative(spec, moduleRel, ctx, []),
  },
];

/**
 * The complete allowlist of code extensions we index: the union of the
 * TypeScript engine's extensions and every tree-sitter grammar's. This is the
 * single gate that keeps extraction code-only. Adding a language means adding
 * an engine above, which extends this set automatically; nothing else (docs,
 * config, data, binaries) is ever walked into the graph.
 */
export const CODE_EXTS: Set<string> = new Set([
  ...TS_EXTS,
  ...SITTER_LANGS.flatMap((def) => def.exts),
]);

/** A file is indexed only when its extension maps to a known language engine. */
export function isCodeFile(name: string): boolean {
  return CODE_EXTS.has(path.extname(name));
}

let parserReady: Promise<{ Parser: any; Language: any }> | null = null;
const loadedLangs = new Map<string, any>();

async function initSitter() {
  if (!parserReady) {
    parserReady = (async () => {
      // Node 24's turboshaft wasm pipeline fatally zone-OOMs while compiling
      // tree-sitter grammars (nodejs/node#63421). Only the --liftoff-only V8
      // flag on the node command line avoids it (runtime setFlagsFromString is
      // too late: the wasm pipeline is configured at startup). bin/gitatlas.js
      // re-execs with the flag and npm test passes it; warn anyone embedding
      // this module directly. Drop when upstream fixes.
      if (parseInt(process.versions.node, 10) >= 24 && !process.execArgv.includes("--liftoff-only")) {
        console.warn(
          "[gitatlas] Node 24+ can crash compiling tree-sitter grammars (nodejs/node#63421); run node with --liftoff-only",
        );
      }
      const WTS: any = await import("web-tree-sitter");
      const Parser = WTS.Parser ?? WTS.default;
      await Parser.init();
      const Language = WTS.Language ?? Parser.Language;
      return { Parser, Language };
    })();
  }
  return parserReady;
}

async function loadLang(def: LangDef) {
  if (loadedLangs.has(def.name)) return loadedLangs.get(def.name);
  const { Language } = await initSitter();
  const wasmDir = path.join(path.dirname(require.resolve("tree-sitter-wasms/package.json")), "out");
  const lang = await Language.load(path.join(wasmDir, `${def.wasm}.wasm`));
  loadedLangs.set(def.name, lang);
  return lang;
}

async function extractSitter(def: LangDef, files: string[], repoRoot: string, repoName: string): Promise<Acc> {
  const acc = newAcc();
  const { Parser } = await initSitter();
  const lang = await loadLang(def);

  const relFiles = files.map((f) => path.relative(repoRoot, f).split(path.sep).join("/"));
  const ctx: ResolveCtx = { repoRoot, relFiles, relSet: new Set(relFiles) };
  if (def.name === "go") {
    const goMod = path.join(repoRoot, "go.mod");
    if (fs.existsSync(goMod)) {
      ctx.goModule = fs.readFileSync(goMod, "utf8").match(/^module\s+(\S+)/m)?.[1];
    }
  }

  for (let i = 0; i < files.length; i++) {
    const rel = relFiles[i];
    const moduleId = `${repoName}:${rel}`;
    const text = fs.readFileSync(files[i], "utf8");
    // fresh parser per file: a mis-parse must never poison the next file
    const parser = new Parser();
    parser.setLanguage(lang);
    let tree;
    try {
      tree = parser.parse(text);
    } catch (err) {
      // Some grammar scanners throw from WASM on rare-but-valid constructs
      // rather than returning an error tree (tree-sitter-bash does this on a
      // `:(){` fork-bomb literal inside a case pattern, for one). The wasm
      // runtime stays healthy afterward, so isolate the failure to this file:
      // record the module (its LOC still counts) with no symbols and continue,
      // instead of aborting the whole repo.
      console.warn(`warning: ${def.name} parser crashed on ${rel}; skipping file (${String(err).split("\n")[0]})`);
      parser.delete();
      acc.modules.push({ id: moduleId, path: rel, repo: repoName, symbolCount: 0, loc: text.split("\n").length });
      continue;
    }
    const root: SitterNode = tree.rootNode;
    let symbolCount = 0;
    const add = (name: string, kind: string, n: SitterNode, exported: boolean, parent?: string) => {
      addSymbolTo(acc, moduleId, name, kind, n.startPosition.row + 1, exported, parent);
      symbolCount++;
    };

    const visitDefs = (node: SitterNode, classCtx: { name: string; id: string } | null, insideFn: boolean, curSym: string | null) => {
      let nextClass = classCtx;
      let nextInsideFn = insideFn;
      let nextSym = curSym;
      let matchedAsDefinition = false;
      const own = (name: string) => `${moduleId}:${name}`;

      const container = def.containerOf?.(node);
      if (container) {
        nextClass = { name: container, id: `${moduleId}:${container}` };
      } else if (def.match) {
        const m = def.match(node);
        if (m) {
          matchedAsDefinition = true;
          if (m.kind === "class" || m.kind === "interface") {
            add(m.name, m.kind, node, m.exported);
            nextClass = { name: m.name, id: own(m.name) };
          } else if (!insideFn) {
            if (classCtx) { add(`${classCtx.name}.${m.name}`, "method", node, m.exported, classCtx.id); nextSym = own(`${classCtx.name}.${m.name}`); }
            else { add(m.name, m.kind, node, m.exported); nextSym = own(m.name); }
            nextInsideFn = true;
          }
        }
      } else if (def.classTypes.includes(node.type) && (!def.classGuard || def.classGuard(node))) {
        const name = def.nameOf(node);
        if (name) {
          const kind = def.classKind ? def.classKind(node) : "class";
          matchedAsDefinition = true;
          add(name, kind, node, def.exported(name, node));
          nextClass = { name, id: own(name) };
          nextSym = own(name);
          for (const sup of def.heritage?.(node) ?? []) {
            if (sup !== name) acc.edges.push({ from: `${moduleId}:${name}`, to: sup, kind: "extends", confidence: "inferred" });
          }
        }
      } else if (def.fnTypes.includes(node.type) && !insideFn) {
        const name = def.nameOf(node);
        if (name) {
          matchedAsDefinition = true;
          const recv = def.receiverOf?.(node);
          if (recv) {
            add(`${recv}.${name}`, "method", node, def.exported(name, node), own(recv));
            nextSym = own(`${recv}.${name}`);
          } else if (classCtx) {
            add(`${classCtx.name}.${name}`, "method", node, def.exported(name, node), classCtx.id);
            nextSym = own(`${classCtx.name}.${name}`);
          } else {
            add(name, "function", node, def.exported(name, node));
            nextSym = own(name);
          }
          nextInsideFn = true;
        }
      }
      if (!matchedAsDefinition && def.calls && def.calls.types.includes(node.type)) {
        const callee = def.calls.callee(node);
        if (callee) acc.rawCalls.push({ from: nextSym ?? moduleId, callee });
      }
      for (const child of node.namedChildren) visitDefs(child, nextClass, nextInsideFn, nextSym);
    };
    visitDefs(root, null, false, null);

    const specs = new Set(def.imports(root));
    for (const t of def.textImports?.(text) ?? []) specs.add(t);
    for (const spec of specs) {
      const resolved = def.resolve(spec, rel, ctx);
      const cleanSpec = spec.replace(/^(req:|rel:)/, "");
      if (resolved) {
        acc.edges.push({ from: moduleId, to: `${repoName}:${resolved}`, kind: "imports", confidence: "resolved" });
      } else {
        acc.edges.push({ from: moduleId, to: `pkg:${cleanSpec}`, kind: "imports", confidence: "exact" });
      }
    }

    for (const id of root.descendantsOfType(def.idTypes)) {
      acc.identCount.set(id.text, (acc.identCount.get(id.text) ?? 0) + 1);
    }
    acc.modules.push({ id: moduleId, path: rel, repo: repoName, symbolCount, loc: text.split("\n").length });
    // trees and parsers live on the wasm heap; without explicit disposal they
    // accumulate for the life of the process (GC never sees that memory)
    tree.delete();
    parser.delete();
  }
  finishRefCounts(acc);
  return acc;
}

// ── merge: one repo, many engines ───────────────────────────────

export async function extractRepo(repoRoot: string, repoName: string, exclude?: Set<string>, ignore?: RegExp[]): Promise<RepoGraph> {
  const all = walk(repoRoot, [], exclude, ignore?.length ? { root: repoRoot, globs: ignore } : undefined);
  const tsFiles = all.filter((f) => TS_EXTS.has(path.extname(f)));
  const accs: Acc[] = [];
  const languages: string[] = [];

  if (tsFiles.length) {
    accs.push(extractTs(tsFiles, repoRoot, repoName));
    languages.push("typescript");
  }
  for (const def of SITTER_LANGS) {
    const langFiles = all.filter((f) => def.exts.includes(path.extname(f)));
    if (langFiles.length) {
      accs.push(await extractSitter(def, langFiles, repoRoot, repoName));
      languages.push(def.name);
    }
  }

  const merged = accs.reduce(
    (m, a) => ({
      modules: m.modules.concat(a.modules),
      symbols: m.symbols.concat(a.symbols),
      edges: m.edges.concat(a.edges),
      rawCalls: m.rawCalls.concat(a.rawCalls),
    }),
    { modules: [] as ModuleNode[], symbols: [] as SymbolNode[], edges: [] as Edge[], rawCalls: [] as RawCall[] },
  );

  // ── call resolution: ambiguous callees are dropped, never guessed ──
  const moduleOf = (id: string) => {
    const c1 = id.indexOf(":");
    const c2 = id.indexOf(":", c1 + 1);
    return c2 === -1 ? id : id.slice(0, c2);
  };
  const byBare = new Map<string, string[]>();
  for (const sym of merged.symbols) {
    const bare = sym.name.includes(".") ? sym.name.split(".").pop()! : sym.name;
    if (!byBare.has(bare)) byBare.set(bare, []);
    byBare.get(bare)!.push(sym.id);
    // classes are also callable by their full name (constructors, Elixir modules)
    if (sym.name !== bare) {
      if (!byBare.has(sym.name)) byBare.set(sym.name, []);
      byBare.get(sym.name)!.push(sym.id);
    }
  }
  const seenCalls = new Set<string>();
  for (const rc of merged.rawCalls) {
    const candidates = byBare.get(rc.callee) ?? [];
    if (candidates.length === 0) continue;
    const fromMod = moduleOf(rc.from);
    const sameModule = candidates.filter((id) => moduleOf(id) === fromMod);
    let to: string | null = null;
    if (sameModule.length === 1) to = sameModule[0];
    else if (sameModule.length === 0 && candidates.length === 1) to = candidates[0];
    if (!to || to === rc.from) continue;
    const key = rc.from + "→" + to;
    if (seenCalls.has(key)) continue;
    seenCalls.add(key);
    merged.edges.push({ from: rc.from, to, kind: "calls", confidence: "resolved" });
  }

  // ── integrity: import edges must land on an indexed module or a pkg: node.
  // A dangling target crashes layout (d3 forceLink throws on unknown ids) ──
  const moduleIdSet = new Set(merged.modules.map((m) => m.id));
  const isDangling = (e: Edge) => e.kind === "imports" && !e.to.startsWith("pkg:") && !moduleIdSet.has(e.to);
  const danglingCount = merged.edges.filter(isDangling).length;
  if (danglingCount > 0) {
    console.warn(`warning: dropped ${danglingCount} import edge(s) with no indexed target module`);
    merged.edges = merged.edges.filter((e) => !isDangling(e));
  }

  // ── analysis: neighborhoods and hubs over the module import graph ──
  const moduleIds = merged.modules.map((m) => m.id);
  const importEdges = merged.edges
    .filter((e) => e.kind === "imports" && !e.to.startsWith("pkg:"))
    .map((e) => ({ from: e.from, to: e.to }));
  // call traffic between modules is real coupling; feed it to neighborhoods and hubs
  for (const e of merged.edges) {
    if (e.kind !== "calls") continue;
    const a = moduleOf(e.from), b = moduleOf(e.to);
    if (a !== b) importEdges.push({ from: a, to: b });
  }
  const neighborhoods = detectNeighborhoods(moduleIds, importEdges);
  const modPath = new Map(merged.modules.map((m) => [m.id, m.path]));
  const labels = labelNeighborhoods(neighborhoods, (id) => modPath.get(id) ?? id);
  const { degree, hubs } = findHubs(moduleIds, importEdges);
  for (const m of merged.modules) {
    m.neighborhood = neighborhoods.get(m.id);
    m.degree = degree.get(m.id) ?? 0;
    m.hub = hubs.has(m.id);
  }

  // ── precomputed layout: modules (with neighborhood anchors), then symbols per module ──
  const nbIds = [...new Set(merged.modules.map((m) => m.neighborhood).filter((n) => n != null))].sort((a, b) => a! - b!) as number[];
  const anchors = nbIds.length > 1 ? neighborhoodAnchors(nbIds) : new Map();
  const modLayout = computeLayout(
    merged.modules.map((m) => ({
      id: m.id, r: 12 + Math.sqrt(m.symbolCount) * 5,
      anchor: m.neighborhood != null ? anchors.get(m.neighborhood) : undefined,
    })),
    importEdges.map((e) => ({ source: e.from, target: e.to })),
  );
  for (const m of merged.modules) {
    const pos = modLayout.get(m.id);
    if (pos) { m.x = pos.x; m.y = pos.y; }
  }
  const symsByModule = new Map<string, SymbolNode[]>();
  for (const sym of merged.symbols) {
    if (!symsByModule.has(sym.module)) symsByModule.set(sym.module, []);
    symsByModule.get(sym.module)!.push(sym);
  }
  const symIds = new Set(merged.symbols.map((s) => s.id));
  const nameToId = new Map(merged.symbols.map((s) => [s.name, s.id]));
  for (const [, syms] of symsByModule) {
    const inModule = new Set(syms.map((s) => s.id));
    const links: { source: string; target: string }[] = [];
    for (const sym of syms) {
      if (sym.parent && inModule.has(sym.parent)) links.push({ source: sym.parent, target: sym.id });
    }
    for (const e of merged.edges) {
      if (e.kind === "calls") {
        if (inModule.has(e.from) && inModule.has(e.to)) links.push({ source: e.from, target: e.to });
        continue;
      }
      if (e.kind !== "extends" && e.kind !== "implements") continue;
      if (!inModule.has(e.from)) continue;
      const to = symIds.has(e.to) ? e.to : nameToId.get(e.to);
      if (to && inModule.has(to)) links.push({ source: e.from, target: to });
    }
    const layout = computeLayout(
      syms.map((s) => ({ id: s.id, r: s.kind === "class" ? 18 : 10 })), links);
    for (const sym of syms) {
      const pos = layout.get(sym.id);
      if (pos) { sym.x = pos.x; sym.y = pos.y; }
    }
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    repo: repoName,
    root: repoRoot,
    language: languages,
    generatedAt: new Date().toISOString(),
    sourceFingerprint: fingerprintFiles(repoRoot, all),
    ...merged,
    neighborhoodLabels: Object.fromEntries(labels),
  };
}
