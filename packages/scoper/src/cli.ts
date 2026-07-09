#!/usr/bin/env node
/**
 * repolens scope --trace <file> [--repo <name>] [--hops N] [--top K] [--json]
 * repolens scope --symbol <name> [...]
 *
 * Loads graphs produced by `extract` and returns the bounded structural
 * neighborhood around a bug signal. Diagnosis-only by construction: there is
 * no write path in this command. It scopes context for a human or an agent to
 * reason over; it does not claim to have found the bug.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { scope, RepoGraph } from "./scope.js";

function loadGraphs(outDir: string): RepoGraph[] {
  const manifestPath = path.join(outDir, "group.json");
  if (!fs.existsSync(manifestPath)) {
    console.error(`no graphs found at ${outDir}. Run: repolens extract <folder> first.`);
    process.exit(1);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  return manifest.repos.map((r: { graphFile: string }) =>
    JSON.parse(fs.readFileSync(path.join(outDir, r.graphFile), "utf8")));
}

function arg(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i > -1 ? args[i + 1] : undefined;
}

function main() {
  const args = process.argv.slice(2);
  if (args[0] !== "scope") {
    console.error("Usage: repolens scope --trace <file> | --symbol <name> [--out <dir>] [--repo <name>] [--hops N] [--top K] [--json]");
    process.exit(1);
  }
  const outDir = path.resolve(arg(args, "--out") ?? path.join(process.cwd(), ".repolens"));
  const tracePath = arg(args, "--trace");
  const symbol = arg(args, "--symbol");
  const repoFilter = arg(args, "--repo");
  const hops = arg(args, "--hops");
  const top = arg(args, "--top");
  const asJson = args.includes("--json");

  if (!tracePath && !symbol) {
    console.error("provide --trace <file> or --symbol <name>");
    process.exit(1);
  }
  const query = tracePath ? fs.readFileSync(path.resolve(tracePath), "utf8") : symbol!;

  let graphs = loadGraphs(outDir);
  if (repoFilter) graphs = graphs.filter((g) => g.repo === repoFilter);

  // try each repo; keep the result with the most confident anchor
  const order = ["exact", "resolved", "inferred", "ambiguous", "none"];
  let best: ReturnType<typeof scope> & { repo?: string } = { anchor: { query, resolved: null, confidence: "none" }, suspects: [], truncated: false };
  for (const g of graphs) {
    const r = scope(query, g, {
      maxHops: hops ? parseInt(hops, 10) : undefined,
      topK: top ? parseInt(top, 10) : undefined,
    });
    if (order.indexOf(r.anchor.confidence) < order.indexOf(best.anchor.confidence)) {
      best = { ...r, repo: g.repo };
    }
  }

  if (asJson) {
    process.stdout.write(JSON.stringify(best, null, 2) + "\n");
    return;
  }

  // text report
  if (!best.anchor.resolved) {
    console.log("Could not resolve the signal to a symbol in the indexed graph.");
    console.log("The throwing file may not be TypeScript/JavaScript, or not yet extracted.");
    return;
  }
  console.log(`anchor: ${best.anchor.resolved}`);
  console.log(`repo: ${best.repo}   confidence: ${best.anchor.confidence}`);
  console.log("");
  console.log(`structural neighborhood (${best.suspects.length} nodes${best.truncated ? ", truncated" : ""}):`);
  console.log("");
  best.suspects.forEach((s, i) => {
    console.log(`  ${String(i + 1).padStart(2)}. ${s.file}:${s.line}  ${s.name} [${s.kind}]`);
    console.log(`      score ${s.score}  ·  ${s.reasons.join("  ·  ")}`);
  });
  console.log("");
  console.log("Note: ranked by structural distance from the symptom, not by likelihood of being");
  console.log("the cause. Bugs from bad data flowing through correct code may sit outside this set.");
  console.log("This is scoped context to reason over, not a diagnosis.");
}

main();
