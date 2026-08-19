/**
 * brief core: compress a group of RepoGraphs into a token-budgeted markdown
 * digest for injection into a coding agent's context. Pure functions only, no
 * file I/O; the CLI and the MCP server both call buildBrief.
 *
 * Honesty rules carry through: the digest states that inferred edges are
 * guesses and that refCount is name-based, and a stale map is flagged inside
 * the text itself (agents rarely see stderr).
 *
 * Determinism: same graphs in, same brief out. Every list is explicitly
 * sorted and capped, and every cap is announced in the text, never silent.
 */
import { RepoGraph, ModuleNode, SymbolNode } from "../../schema/src/types.js";

export interface BriefOptions {
  /** approximate token budget for the whole brief (default 4000) */
  budgetTokens?: number;
  /** limit the brief to one repo */
  repo?: string;
  /** repos whose graphs failed a freshness check; flagged in the text */
  staleRepos?: string[];
}

export interface Brief {
  text: string;
  /** detail level that fit the budget: 1 summary .. 5 key exports */
  level: number;
  /** section names dropped to fit the budget */
  omitted: string[];
}

/** chars/4: the standard rough token estimate, good enough for budgeting */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const LEVEL_SECTIONS: Record<number, string> = {
  2: "hubs",
  3: "neighborhoods",
  4: "largest modules",
  5: "key exports",
};
const MAX_LEVEL = 5;
const CAPS = { hubs: 5, neighborhoods: 6, modules: 5, exports: 8 };

function withOverflow(names: string[], cap: number): string {
  const shown = names.slice(0, cap);
  const extra = names.length - shown.length;
  return shown.join(", ") + (extra > 0 ? `, +${extra} more` : "");
}

function repoSection(g: RepoGraph, level: number): string {
  const lines: string[] = [];
  const langs = g.language.length ? g.language.join(", ") : "no supported files";
  const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
  const commitNote = g.commit ? ` @ ${g.commit.slice(0, 12)}${g.dirty ? " (dirty)" : ""}` : "";
  lines.push(`## ${g.repo}${commitNote} (${langs}): ${count(g.modules.length, "module")}, ${count(g.symbols.length, "symbol")}`);

  if (level >= 2) {
    const hubs = g.modules.filter((m) => m.hub)
      .sort((a, b) => (b.degree ?? 0) - (a.degree ?? 0) || a.path.localeCompare(b.path));
    if (hubs.length) {
      lines.push(`hubs (widest change ripple): ${withOverflow(hubs.map((m) => `${m.path} (${m.degree ?? 0} links)`), CAPS.hubs)}`);
    }
  }

  if (level >= 3 && g.neighborhoodLabels) {
    const sizes = new Map<number, number>();
    for (const m of g.modules) {
      if (m.neighborhood != null) sizes.set(m.neighborhood, (sizes.get(m.neighborhood) ?? 0) + 1);
    }
    const hoods = [...sizes.entries()]
      .map(([id, count]) => ({ label: g.neighborhoodLabels![String(id)] ?? `#${id}`, count }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
    if (hoods.length > 1) {
      lines.push(`neighborhoods (clustered from imports/calls, not folders): ${withOverflow(hoods.map((h) => `${h.label} (${h.count})`), CAPS.neighborhoods)}`);
    }
  }

  if (level >= 4) {
    const top = [...g.modules]
      .sort((a: ModuleNode, b: ModuleNode) => b.symbolCount - a.symbolCount || a.path.localeCompare(b.path))
      .slice(0, CAPS.modules);
    if (top.length) {
      lines.push(`largest modules: ${top.map((m) => `${m.path} (${m.symbolCount})`).join(", ")}`);
    }
  }

  if (level >= 5) {
    const modPath = new Map(g.modules.map((m) => [m.id, m.path]));
    const exports = g.symbols.filter((s) => s.exported)
      .sort((a: SymbolNode, b: SymbolNode) => (b.refCount ?? 0) - (a.refCount ?? 0) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    if (exports.length) {
      lines.push(`key exports (by reference count): ${withOverflow(
        exports.map((s) => `${s.name} [${s.kind}] ${modPath.get(s.module) ?? s.module}:${s.line}`), CAPS.exports)}`);
    }
  }

  return lines.join("\n");
}

function render(group: string, graphs: RepoGraph[], level: number, staleRepos: string[], omitted: string[]): string {
  const modules = graphs.reduce((n, g) => n + g.modules.length, 0);
  const symbols = graphs.reduce((n, g) => n + g.symbols.length, 0);
  const newest = graphs.map((g) => g.generatedAt).sort().at(-1) ?? "unknown";
  const parts: string[] = [];
  parts.push(`# ${group}: architecture brief`);
  parts.push(`${graphs.length} repo${graphs.length === 1 ? "" : "s"}, ${modules} modules, ${symbols} symbols. Extracted ${newest}.`);
  if (staleRepos.length) {
    parts.push(`WARNING: the map is stale for ${staleRepos.join(", ")}; file:line data may be wrong. Regenerate with: gitatlas extract <folder> --if-stale`);
  }
  parts.push("Edges carry confidence (exact, resolved, inferred); inferred is a labeled guess, never a fact. refCount is name-based: 0 means no references found in indexed code, not dead code.");
  for (const g of graphs) parts.push(repoSection(g, level));
  if (omitted.length) {
    parts.push(`(trimmed to fit the token budget: ${omitted.join(", ")} omitted; raise --budget to include)`);
  }
  parts.push("Deeper queries: gitatlas scope --symbol <name> --json (or --trace <crash-file>) ranks the structural neighborhood around a symptom.");
  return parts.join("\n\n") + "\n";
}

export function buildBrief(group: string, graphs: RepoGraph[], opts: BriefOptions = {}): Brief {
  const budget = opts.budgetTokens ?? 4000;
  const selected = opts.repo ? graphs.filter((g) => g.repo === opts.repo) : graphs;
  if (opts.repo && selected.length === 0) {
    throw new Error(`repo "${opts.repo}" not found in the map (have: ${graphs.map((g) => g.repo).join(", ")})`);
  }
  const stale = (opts.staleRepos ?? []).filter((r) => selected.some((g) => g.repo === r));

  // highest detail level that fits the budget; level 1 always emits
  for (let level = MAX_LEVEL; level >= 1; level--) {
    const omitted = Object.entries(LEVEL_SECTIONS)
      .filter(([l]) => parseInt(l, 10) > level)
      .map(([, name]) => name);
    const text = render(group, selected, level, stale, omitted);
    if (estimateTokens(text) <= budget || level === 1) {
      return { text, level, omitted };
    }
  }
  throw new Error("unreachable");
}
