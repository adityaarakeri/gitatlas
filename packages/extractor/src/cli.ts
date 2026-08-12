#!/usr/bin/env node
/**
 * gitatlas extract <group-folder|github-repo> [--out <dir>] [--ref <branch|tag|commit>]
 *                  [--depth N] [--max-scan N] [--submodules split|absorb|skip]
 *                  [--ignore <glob>]... [--if-stale] [--cache-dir <dir>]
 * gitatlas check   <group-folder|github-repo> [same flags] [--json]
 *
 * The target is a folder, or a GitHub repo ("owner/repo", "github.com/owner/repo",
 * a browser URL, an scp-style git@ address). A GitHub target is shallow-cloned
 * into ~/.gitatlas/repos/<owner>/<repo> and refreshed on later runs; a path that
 * exists on disk always wins, so nothing local turns into a network call.
 *
 * --ref pins a branch, tag, or commit, as does a /tree/<ref>/ URL. Each ref gets
 * its own clone (<repo>@<ref>), which is also the name its map carries.
 *
 * Common build artifacts (node_modules, dist, build, *.egg-info, dot-dirs, ...)
 * and documentation trees (docs, doc) are skipped by default; --ignore adds
 * project-specific globs on top, matched against each entry's name and its
 * repo-relative path. Repeatable.
 *
 * `check` re-walks the source with the same flags and compares content
 * fingerprints against the existing map: no parsing, no writes, exit 0 fresh /
 * 1 stale. `extract --if-stale` runs the same comparison first and skips the
 * whole extraction when nothing changed, so callers (CI, agents) can run it
 * unconditionally before reading the graphs.
 *
 * Discovery and orchestration live here. Actual extraction lives in
 * extract.ts so tests and other tools can import it directly.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { extractRepo, walk, fingerprintFiles, shouldSkipDir, globToRegExp, SCHEMA_VERSION, Edge } from "./extract.js";
import { parseGitmodules } from "./freshness.js";
import { computeLayout } from "./layout.js";
import { resolveTarget, TargetError } from "./clone.js";

const USAGE = [
  "Usage: gitatlas extract <group-folder|github-repo> [--out <dir>] [--ref <branch|tag|commit>] [--lang <code>] [--depth N] [--max-scan N] [--submodules split|absorb|skip] [--ignore <glob>]... [--if-stale] [--cache-dir <dir>]",
  "       gitatlas check   <group-folder|github-repo> [same flags] [--json]",
].join("\n");

// ── viewer UI catalogs ──
// Every catalog is baked into the generated file so one HTML can be opened by
// a mixed-language team; --lang only picks which one it opens in. Four extra
// catalogs cost about 4 KB, which is well under the d3 bundle already in there.
const LOCALES_DIR = path.join(__dirname, "..", "..", "viewer", "locales");

interface LocaleCatalog {
  locale: string;
  name: string;
  reviewed: boolean;
  maintainer: string | null;
  strings: Record<string, string | Record<string, string>>;
}

function availableLocales(): string[] {
  if (!fs.existsSync(LOCALES_DIR)) return ["en"];
  return fs.readdirSync(LOCALES_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -".json".length))
    .sort();
}

/**
 * en.json is a shipped asset, not user input: if it is missing the viewer has
 * no fallback for any key, so fail loudly rather than emit a map full of
 * untranslated key names.
 */
function loadLocales(): Record<string, LocaleCatalog> {
  const catalogs: Record<string, LocaleCatalog> = {};
  for (const code of availableLocales()) {
    const file = path.join(LOCALES_DIR, `${code}.json`);
    if (!fs.existsSync(file)) continue;
    catalogs[code] = JSON.parse(fs.readFileSync(file, "utf8")) as LocaleCatalog;
  }
  if (!catalogs.en) {
    console.error(`build error: no viewer locale catalog at ${path.join(LOCALES_DIR, "en.json")}`);
    process.exit(1);
  }
  return catalogs;
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  if ((cmd !== "extract" && cmd !== "check") || !args[1]) {
    console.error(USAGE);
    process.exit(1);
  }

  // ── target: a folder to walk, or a GitHub repo to clone into the cache ──
  const cacheIdx = args.indexOf("--cache-dir");
  const refIdx = args.indexOf("--ref");
  let groupDir: string;
  try {
    groupDir = resolveTarget(args[1], {
      cacheRoot: cacheIdx > -1 ? path.resolve(args[cacheIdx + 1]) : undefined,
      ref: refIdx > -1 ? args[refIdx + 1] : undefined,
    });
  } catch (error) {
    if (!(error instanceof TargetError)) throw error;
    console.error(error.message);
    process.exit(1);
  }
  const outIdx = args.indexOf("--out");
  const outDir = path.resolve(outIdx > -1 ? args[outIdx + 1] : path.join(groupDir, ".gitatlas"));

  // ── viewer language: which catalog the generated file opens in ──
  const langIdx = args.indexOf("--lang");
  const lang = langIdx > -1 ? args[langIdx + 1] : undefined;
  if (langIdx > -1 && !availableLocales().includes(lang as string)) {
    console.error(`unknown --lang ${lang ?? ""}: available locales are ${availableLocales().join(", ")}`);
    process.exit(1);
  }

  // ── user-supplied ignore globs (repeatable), additive to the built-in skips ──
  const ignoreGlobs: RegExp[] = [];
  for (let k = 0; k < args.length - 1; k++) {
    if (args[k] === "--ignore") ignoreGlobs.push(globToRegExp(args[k + 1]));
  }

  // ── repo discovery: any structure ──
  // 1. Target itself is a repo (.git): index just it.
  // 2. Otherwise scan for .git markers at ANY depth, stopping inside each repo
  //    found and at SKIP_DIRS.
  // 3. Safety valve: scanned-directory budget (default 25000, --max-scan),
  //    optional hard cap with --depth.
  // 4. No .git anywhere: each top-level folder is one project.
  function findRepos(root: string, maxDepth: number, maxScan: number): { name: string; dir: string }[] {
    if (fs.existsSync(path.join(root, ".git"))) {
      return [{ name: path.basename(root), dir: root }];
    }
    const found: { name: string; dir: string }[] = [];
    let scanned = 0;
    let truncated = false;
    const scan = (dir: string, depth: number) => {
      if (depth > maxDepth) return;
      if (scanned++ > maxScan) { truncated = true; return; }
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); } catch { return; }
      for (const entry of entries) {
        if (!entry.isDirectory() || shouldSkipDir(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (fs.existsSync(path.join(full, ".git"))) {
          found.push({ name: entry.name, dir: full });
        } else {
          scan(full, depth + 1);
        }
      }
    };
    scan(root, 1);
    if (truncated) {
      console.warn(`warning: discovery stopped after scanning ${maxScan} directories; rerun with --max-scan <n> to search further`);
    }
    if (found.length > 0) return found;
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !shouldSkipDir(e.name))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((e) => ({ name: e.name, dir: path.join(root, e.name) }));
  }
  const depthIdx = args.indexOf("--depth");
  const maxDepth = depthIdx > -1 ? parseInt(args[depthIdx + 1], 10) : Infinity;
  const scanIdx = args.indexOf("--max-scan");
  const maxScan = scanIdx > -1 ? parseInt(args[scanIdx + 1], 10) : 25000;
  const repos = findRepos(groupDir, maxDepth, maxScan);

  // ── submodules: split (default) | absorb | skip ──
  const subIdx = args.indexOf("--submodules");
  const subMode = subIdx > -1 ? args[subIdx + 1] : "split";
  const excludes = new Map<string, Set<string>>();

  if (subMode !== "absorb") {
    const seen = new Set(repos.map((r) => fs.realpathSync(r.dir)));
    const queue = [...repos];
    while (queue.length) {
      const repo = queue.shift()!;
      for (const subPath of parseGitmodules(repo.dir)) {
        const subDir = path.join(repo.dir, subPath);
        if (!excludes.has(repo.dir)) excludes.set(repo.dir, new Set());
        excludes.get(repo.dir)!.add(path.resolve(subDir));
        const initialized = fs.existsSync(path.join(subDir, ".git"));
        if (subMode === "split" && initialized) {
          const real = fs.realpathSync(subDir);
          if (seen.has(real)) continue;
          seen.add(real);
          const base = path.basename(subPath);
          const name = repos.some((r) => r.name === base) ? `${repo.name}/${base}` : base;
          const sub = { name, dir: subDir };
          repos.push(sub);
          queue.push(sub);
        } else if (subMode === "split" && !initialized) {
          console.warn(`note: submodule ${repo.name}/${subPath} is not initialized (run git submodule update --init), skipping`);
        }
      }
    }
  }
  // ── freshness: content fingerprints of the walk vs the existing map ──
  // Statuses: fresh (fingerprint matches), stale (source changed), new (repo
  // has no graph yet), removed (graph exists, repo gone from disk), unknown
  // (pre-fingerprint graph). Anything but fresh means re-extract.
  type Freshness = { name: string; status: "fresh" | "stale" | "new" | "removed" | "unknown" };
  function checkFreshness(): Freshness[] {
    const manifestPath = path.join(outDir, "group.json");
    if (!fs.existsSync(manifestPath)) {
      return repos.map(({ name }) => ({ name, status: "new" as const }));
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      repos: { name: string; graphFile: string }[];
    };
    const byName = new Map(manifest.repos.map((r) => [r.name, r]));
    const statuses: Freshness[] = [];
    for (const { name, dir } of repos) {
      const entry = byName.get(name);
      const graphPath = entry && path.join(outDir, entry.graphFile);
      if (!graphPath || !fs.existsSync(graphPath)) {
        statuses.push({ name, status: "new" });
        continue;
      }
      const graph = JSON.parse(fs.readFileSync(graphPath, "utf8")) as { sourceFingerprint?: string };
      if (!graph.sourceFingerprint) {
        statuses.push({ name, status: "unknown" });
        continue;
      }
      const files = walk(dir, [], excludes.get(dir), ignoreGlobs.length ? { root: dir, globs: ignoreGlobs } : undefined);
      statuses.push({ name, status: graph.sourceFingerprint === fingerprintFiles(dir, files) ? "fresh" : "stale" });
    }
    const discovered = new Set(repos.map((r) => r.name));
    for (const r of manifest.repos) {
      if (!discovered.has(r.name)) statuses.push({ name: r.name, status: "removed" });
    }
    return statuses;
  }

  if (cmd === "check") {
    const statuses = checkFreshness();
    const fresh = statuses.length > 0 && statuses.every((s) => s.status === "fresh");
    if (args.includes("--json")) {
      process.stdout.write(JSON.stringify({ fresh, outDir, repos: statuses }, null, 2) + "\n");
    } else if (statuses.length === 0) {
      console.log("no repos discovered and no map found; nothing to compare");
    } else {
      const pad = Math.max(...statuses.map((s) => s.name.length));
      for (const s of statuses) console.log(`  ${s.name.padEnd(pad)}  ${s.status}`);
      console.log(fresh
        ? `map is fresh (${statuses.length} repo${statuses.length === 1 ? "" : "s"})`
        : "map is stale; run: gitatlas extract " + args[1]);
    }
    if (!fresh) process.exitCode = 1;
    return;
  }

  if (args.includes("--if-stale")) {
    const statuses = checkFreshness();
    if (statuses.length > 0 && statuses.every((s) => s.status === "fresh")) {
      console.log(`map is fresh (${statuses.length} repo${statuses.length === 1 ? "" : "s"}), skipping extraction`);
      return;
    }
    const changed = statuses.filter((s) => s.status !== "fresh").map((s) => `${s.name} (${s.status})`);
    console.log(`map is stale [${changed.join(", ")}], re-extracting`);
  }

  fs.mkdirSync(outDir, { recursive: true });
  console.log(`discovered ${repos.length} repos (submodules: ${subMode})`);
  if (ignoreGlobs.length) console.log(`ignoring ${ignoreGlobs.length} custom glob(s) on top of built-in skips`);

  // ── extract each repo, write graphs + manifest ──
  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    group: path.basename(groupDir),
    generatedAt: new Date().toISOString(),
    repos: [] as { name: string; graphFile: string; moduleCount: number; symbolCount: number; languages: string[] }[],
    edges: [] as Edge[],
  };

  for (const { name, dir } of repos) {
    const graph = await extractRepo(dir, name, excludes.get(dir), ignoreGlobs);
    const graphFile = `${name.replace(/\//g, "__")}.graph.json`;
    fs.writeFileSync(path.join(outDir, graphFile), JSON.stringify(graph, null, 2));
    manifest.repos.push({
      name, graphFile,
      moduleCount: graph.modules.length,
      symbolCount: graph.symbols.length,
      languages: graph.language,
    });
    console.log(`indexed ${name} [${graph.language.join(", ") || "no supported files"}]: ${graph.modules.length} modules, ${graph.symbols.length} symbols, ${graph.edges.length} edges`);
  }

  // L0 layout: repo nodes, deterministic
  const repoLayout = computeLayout(
    manifest.repos.map((r) => ({ id: r.name, r: 26 + Math.sqrt(r.symbolCount) * 4 })),
    manifest.edges.map((e) => ({ source: e.from, target: e.to })),
  );
  for (const r of manifest.repos as (typeof manifest.repos[number] & { x?: number; y?: number })[]) {
    const pos = repoLayout.get(r.name);
    if (pos) { r.x = pos.x; r.y = pos.y; }
  }

  fs.writeFileSync(path.join(outDir, "group.json"), JSON.stringify(manifest, null, 2));
  console.log(`group manifest -> ${path.join(outDir, "group.json")}`);

  // ── viewer generation: one self-contained HTML file ──
  const templatePath = path.join(__dirname, "..", "..", "viewer", "template.html");
  if (fs.existsSync(templatePath)) {
    const locales = loadLocales();
    const graphsData = manifest.repos.map((r) =>
      JSON.parse(fs.readFileSync(path.join(outDir, r.graphFile), "utf8")));
    // vendor d3 into the file: the map now opens with zero network requests
    // d3's exports map blocks require.resolve entirely for subpaths, so find
    // it on disk: walk up from here until node_modules/d3/dist/d3.min.js exists
    let d3src = "";
    for (let dir = __dirname; dir !== path.dirname(dir); dir = path.dirname(dir)) {
      const cand = path.join(dir, "node_modules", "d3", "dist", "d3.min.js");
      if (fs.existsSync(cand)) { d3src = fs.readFileSync(cand, "utf8"); break; }
    }
    if (!d3src) console.warn("warning: d3 not found on disk; keeping CDN script tag");
    const html = fs.readFileSync(templatePath, "utf8")
      .replace(/<script src="https:[^"]*d3[^"]*"><\/script>/, () => d3src ? "<script>" + d3src + "</scr" + "ipt>" : "<script src=\"https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js\"></scr" + "ipt>")
      .replace("/*__DATA__*/null", () => JSON.stringify({ manifest, graphs: graphsData }))
      .replace("/*__LOCALES__*/null", () => JSON.stringify(locales))
      .replace("/*__LANG__*/null", () => JSON.stringify(lang ?? null));
    fs.writeFileSync(path.join(outDir, "index.html"), html);
    console.log(`viewer -> ${path.join(outDir, "index.html")} (open it in any browser)`);
  } else {
    console.warn("warning: viewer template not found, skipped HTML generation");
  }
}

void main();
