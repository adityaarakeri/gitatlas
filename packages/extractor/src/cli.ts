#!/usr/bin/env node
/**
 * repolens extract <group-folder> [--out <dir>] [--depth N] [--max-scan N]
 *                  [--submodules split|absorb|skip] [--ignore <glob>]...
 *
 * Common build artifacts (node_modules, dist, build, *.egg-info, dot-dirs, ...)
 * and documentation trees (docs, doc) are skipped by default; --ignore adds
 * project-specific globs on top, matched against each entry's name and its
 * repo-relative path. Repeatable.
 *
 * Discovery and orchestration live here. Actual extraction lives in
 * extract.ts so tests and other tools can import it directly.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { extractRepo, shouldSkipDir, globToRegExp, SCHEMA_VERSION, Edge } from "./extract.js";
import { computeLayout } from "./layout.js";

async function main() {
  const args = process.argv.slice(2);
  if (args[0] !== "extract" || !args[1]) {
    console.error("Usage: repolens extract <group-folder> [--out <dir>] [--depth N] [--max-scan N] [--submodules split|absorb|skip] [--ignore <glob>]...");
    process.exit(1);
  }
  const groupDir = path.resolve(args[1]);
  const outIdx = args.indexOf("--out");
  const outDir = path.resolve(outIdx > -1 ? args[outIdx + 1] : path.join(groupDir, ".repolens"));
  fs.mkdirSync(outDir, { recursive: true });

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

  function parseGitmodules(repoDir: string): string[] {
    const file = path.join(repoDir, ".gitmodules");
    if (!fs.existsSync(file)) return [];
    const paths: string[] = [];
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const m = line.match(/^\s*path\s*=\s*(.+)\s*$/);
      if (m) paths.push(m[1].trim());
    }
    return paths;
  }

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
      .replace("/*__DATA__*/null", () => JSON.stringify({ manifest, graphs: graphsData }));
    fs.writeFileSync(path.join(outDir, "index.html"), html);
    console.log(`viewer -> ${path.join(outDir, "index.html")} (open it in any browser)`);
  } else {
    console.warn("warning: viewer template not found, skipped HTML generation");
  }
}

main();
