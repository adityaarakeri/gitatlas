#!/usr/bin/env node
/**
 * gitatlas brief [--out <dir>] [--repo <name>] [--budget <tokens>]
 *                [--ignore <glob>]...
 *
 * Emits a token-budgeted markdown digest of an extracted map to stdout,
 * shaped for injection into a coding agent's context. Before emitting it
 * re-checks the source fingerprints; a stale repo is flagged inside the
 * brief itself, because agents rarely see stderr.
 *
 * --ignore should mirror the globs used at extract time so the freshness
 * walk covers the same file set. I/O only; the digest lives in brief.ts.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { globToRegExp } from "../../extractor/src/extract.js";
import { graphFreshness } from "../../extractor/src/freshness.js";
import { RepoGraph, GroupManifest } from "../../schema/src/types.js";
import { buildBrief } from "./brief.js";

function loadGraphs(outDir: string): { manifest: GroupManifest; graphs: RepoGraph[] } {
  const manifestPath = path.join(outDir, "group.json");
  if (!fs.existsSync(manifestPath)) {
    console.error(`no graphs found at ${outDir}. Run: gitatlas extract <folder> first.`);
    process.exit(1);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as GroupManifest;
  const graphs = manifest.repos.map((r) =>
    JSON.parse(fs.readFileSync(path.join(outDir, r.graphFile), "utf8")) as RepoGraph);
  return { manifest, graphs };
}

function arg(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i > -1 ? args[i + 1] : undefined;
}

function main() {
  const args = process.argv.slice(2);
  if (args[0] !== "brief") {
    console.error("Usage: gitatlas brief [--out <dir>] [--repo <name>] [--budget <tokens>] [--ignore <glob>]...");
    process.exit(1);
  }
  const outDir = path.resolve(arg(args, "--out") ?? path.join(process.cwd(), ".gitatlas"));
  const repo = arg(args, "--repo");
  const budgetRaw = arg(args, "--budget");
  const budget = budgetRaw ? parseInt(budgetRaw, 10) : undefined;
  if (budgetRaw && (!Number.isInteger(budget) || budget! <= 0)) {
    console.error(`--budget must be a positive integer, got: ${budgetRaw}`);
    process.exit(1);
  }
  const ignore: RegExp[] = [];
  for (let k = 0; k < args.length - 1; k++) {
    if (args[k] === "--ignore") ignore.push(globToRegExp(args[k + 1]));
  }

  const { manifest, graphs } = loadGraphs(outDir);
  const freshness = graphFreshness(graphs, { ignore });
  const staleRepos = freshness.filter((f) => f.status !== "fresh").map((f) => f.repo);
  if (staleRepos.length) {
    console.error(`warning: map not verified fresh for ${staleRepos.join(", ")}; the brief flags this inline`);
  }

  try {
    const brief = buildBrief(manifest.group, graphs, { budgetTokens: budget, repo, staleRepos });
    process.stdout.write(brief.text);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

main();
