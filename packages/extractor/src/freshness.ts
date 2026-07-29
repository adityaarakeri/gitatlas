/**
 * Graph-side freshness: can an existing RepoGraph still be trusted?
 *
 * Root-based, unlike `gitatlas check`: it re-walks each graph's recorded
 * source root and compares content fingerprints. It cannot discover brand-new
 * repos (that needs the group folder and discovery flags), it only answers
 * "has the source this graph came from changed". Consumers that inject graph
 * data into an agent context (brief, mcp) call this before every emission.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { walk, fingerprintFiles } from "./extract.js";

/** .gitmodules `path = ...` entries of a repo, repo-relative. */
export function parseGitmodules(repoDir: string): string[] {
  const file = path.join(repoDir, ".gitmodules");
  if (!fs.existsSync(file)) return [];
  const paths: string[] = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*path\s*=\s*(.+)\s*$/);
    if (m) paths.push(m[1].trim());
  }
  return paths;
}

export interface GraphFreshness {
  repo: string;
  /** fresh: fingerprint matches; stale: source changed; unknown: no
   * fingerprint in the graph (pre-fingerprint extract) or root missing
   * (map generated on another machine). unknown means "cannot verify",
   * never "verified". */
  status: "fresh" | "stale" | "unknown";
}

export function graphFreshness(
  graphs: { repo: string; root: string; sourceFingerprint?: string }[],
  opts: { ignore?: RegExp[]; excludeSubmodules?: boolean } = {},
): GraphFreshness[] {
  // submodule paths are excluded by default, matching split/skip extraction
  // (each split submodule carries its own graph and gets walked via its own
  // root); pass excludeSubmodules: false for absorb-mode maps
  const excludeSubs = opts.excludeSubmodules ?? true;
  return graphs.map((g) => {
    if (!g.sourceFingerprint || !fs.existsSync(g.root)) {
      return { repo: g.repo, status: "unknown" as const };
    }
    const exclude = excludeSubs
      ? new Set(parseGitmodules(g.root).map((p) => path.resolve(g.root, p)))
      : undefined;
    const files = walk(g.root, [], exclude,
      opts.ignore?.length ? { root: g.root, globs: opts.ignore } : undefined);
    const status = fingerprintFiles(g.root, files) === g.sourceFingerprint ? "fresh" : "stale";
    return { repo: g.repo, status: status as "fresh" | "stale" };
  });
}
