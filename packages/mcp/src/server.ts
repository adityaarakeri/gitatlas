/**
 * MCP tool logic: pure functions over loaded graphs, no I/O and no protocol.
 * The stdio JSON-RPC framing lives in cli.ts, mirroring the scoper split.
 *
 * Every tool that emits graph data carries the staleness verdict the caller
 * computed, so an agent is never handed file:line data without knowing
 * whether the map still matches the source.
 */
import { RepoGraph, ModuleNode } from "../../schema/src/types.js";
import { GraphFreshness } from "../../extractor/src/freshness.js";
import { scope } from "../../scoper/src/scope.js";
import { buildBrief } from "../../brief/src/brief.js";

export interface ToolContext {
  group: string;
  graphs: RepoGraph[];
  /** repos whose graphs failed the freshness check (stale or unverifiable) */
  staleRepos: string[];
  /** full per-repo freshness report, recomputed for check_freshness */
  freshness: GraphFreshness[];
}

export interface ToolResult {
  text: string;
  isError?: boolean;
}

const FIND_CAP = 30;
const MODULE_LIST_CAP = 50;

export const TOOLS = [
  {
    name: "brief",
    description: "Token-budgeted markdown digest of the whole map: per repo, its hubs (widest change ripple), neighborhoods (clustered from real imports/calls, not folders), largest modules, and key exports with file:line. Call this first to orient in an unfamiliar codebase.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "limit the brief to one repo" },
        budget: { type: "number", description: "approximate token budget (default 4000); detail sections drop to fit" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "scope",
    description: "Rank the structural neighborhood around a bug signal: paste a stack trace or name a symbol, get suspects with file:line ordered by structural distance. Retrieval, not diagnosis: bugs from bad data flowing through correct code can sit outside the set.",
    inputSchema: {
      type: "object",
      properties: {
        trace: { type: "string", description: "stack trace text (V8/Node format)" },
        symbol: { type: "string", description: "bare symbol name to anchor on, if no trace" },
        repo: { type: "string", description: "limit resolution to one repo" },
        hops: { type: "number", description: "max BFS hops from the anchor (default 2)" },
        top: { type: "number", description: "max suspects returned (default 8)" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "find_symbol",
    description: "Locate symbols by name across every repo in the map. Exact matches win; otherwise case-insensitive substring. Returns id, kind, file:line, exported, and refCount (name-based: 0 means no references found in indexed code, not dead code).",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "symbol name or fragment" },
        repo: { type: "string", description: "limit the search to one repo" },
        exact: { type: "boolean", description: "require an exact name match" },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "module_info",
    description: "Everything the map knows about one module (file): symbols with lines, imports in and out, call traffic, neighborhood, and whether it is a hub. Accepts a module id, an exact repo-relative path, or a unique path suffix.",
    inputSchema: {
      type: "object",
      properties: {
        module: { type: "string", description: "module id (repo:path), exact path, or path suffix" },
        repo: { type: "string", description: "limit the lookup to one repo" },
      },
      required: ["module"],
      additionalProperties: false,
    },
  },
  {
    name: "check_freshness",
    description: "Re-hash the source trees and report per repo whether the map is still trustworthy: fresh (verified), stale (source changed), or unknown (cannot verify). Run gitatlas extract --if-stale to rebuild a stale map.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

function bare(name: string): string {
  return name.includes(".") ? name.split(".").pop()! : name;
}

/** shared result envelope: staleness first, so it is never buried */
function envelope(ctx: ToolContext, payload: Record<string, unknown>): string {
  const out: Record<string, unknown> = {};
  if (ctx.staleRepos.length) {
    out.stale_warning = `map not verified fresh for ${ctx.staleRepos.join(", ")}; file:line data may be wrong. Rebuild: gitatlas extract <folder> --if-stale`;
  }
  return JSON.stringify({ ...out, ...payload }, null, 2);
}

function toolBrief(ctx: ToolContext, args: Record<string, unknown>): ToolResult {
  const brief = buildBrief(ctx.group, ctx.graphs, {
    repo: typeof args.repo === "string" ? args.repo : undefined,
    budgetTokens: typeof args.budget === "number" ? args.budget : undefined,
    staleRepos: ctx.staleRepos,
  });
  return { text: brief.text };
}

function toolScope(ctx: ToolContext, args: Record<string, unknown>): ToolResult {
  const query = typeof args.trace === "string" && args.trace.trim()
    ? args.trace
    : typeof args.symbol === "string" ? args.symbol : undefined;
  if (!query) return { text: "provide trace or symbol", isError: true };
  const graphs = typeof args.repo === "string" ? ctx.graphs.filter((g) => g.repo === args.repo) : ctx.graphs;
  // best anchor across repos, same policy as the scope CLI
  const order = ["exact", "resolved", "inferred", "ambiguous", "none"];
  let best: ReturnType<typeof scope> & { repo?: string } = {
    anchor: { query, resolved: null, confidence: "none" }, suspects: [], truncated: false,
  };
  for (const g of graphs) {
    const r = scope(query, g, {
      maxHops: typeof args.hops === "number" ? args.hops : undefined,
      topK: typeof args.top === "number" ? args.top : undefined,
    });
    if (order.indexOf(r.anchor.confidence) < order.indexOf(best.anchor.confidence)) {
      best = { ...r, repo: g.repo };
    }
  }
  return {
    text: envelope(ctx, {
      ...best,
      note: "suspects are ranked by structural distance from the symptom, not by likelihood of being the cause",
    }),
  };
}

function toolFindSymbol(ctx: ToolContext, args: Record<string, unknown>): ToolResult {
  if (typeof args.name !== "string" || !args.name.trim()) {
    return { text: "name is required", isError: true };
  }
  const q = args.name.trim();
  const ql = q.toLowerCase();
  const graphs = typeof args.repo === "string" ? ctx.graphs.filter((g) => g.repo === args.repo) : ctx.graphs;
  type Hit = { repo: string; id: string; name: string; kind: string; file: string; line: number; exported: boolean; refCount?: number; exact: boolean };
  const hits: Hit[] = [];
  for (const g of graphs) {
    const modPath = new Map(g.modules.map((m) => [m.id, m.path]));
    for (const s of g.symbols) {
      const exact = s.name === q || bare(s.name) === q;
      if (!exact && (args.exact === true || !s.name.toLowerCase().includes(ql))) continue;
      hits.push({
        repo: g.repo, id: s.id, name: s.name, kind: s.kind,
        file: modPath.get(s.module) ?? s.module, line: s.line,
        exported: s.exported, refCount: s.refCount, exact,
      });
    }
  }
  // exact matches make substring noise irrelevant
  const pool = hits.some((h) => h.exact) && args.exact !== true ? hits.filter((h) => h.exact) : hits;
  pool.sort((a, b) => Number(b.exact) - Number(a.exact) || a.repo.localeCompare(b.repo)
    || a.file.localeCompare(b.file) || a.line - b.line || a.id.localeCompare(b.id));
  const truncated = pool.length > FIND_CAP;
  return {
    text: envelope(ctx, {
      query: q,
      matches: pool.slice(0, FIND_CAP).map(({ exact: _exact, ...rest }) => rest),
      ...(truncated ? { truncated: `showing ${FIND_CAP} of ${pool.length} matches; narrow the name` } : {}),
    }),
  };
}

function toolModuleInfo(ctx: ToolContext, args: Record<string, unknown>): ToolResult {
  if (typeof args.module !== "string" || !args.module.trim()) {
    return { text: "module is required", isError: true };
  }
  const q = args.module.trim().replace(/\\/g, "/");
  const graphs = typeof args.repo === "string" ? ctx.graphs.filter((g) => g.repo === args.repo) : ctx.graphs;
  const candidates: { g: RepoGraph; m: ModuleNode }[] = [];
  for (const g of graphs) {
    for (const m of g.modules) {
      if (m.id === q || m.path === q || m.path.endsWith(q)) candidates.push({ g, m });
    }
  }
  if (candidates.length === 0) {
    return { text: envelope(ctx, { error: `no module matches "${q}"`, hint: "try find_symbol, or a longer path suffix" }), isError: true };
  }
  if (candidates.length > 1) {
    return {
      text: envelope(ctx, {
        error: `"${q}" is ambiguous (${candidates.length} modules)`,
        candidates: candidates.slice(0, MODULE_LIST_CAP).map((c) => c.m.id).sort(),
      }),
      isError: true,
    };
  }
  const { g, m } = candidates[0];
  const cap = <T>(list: T[]) => ({
    items: list.slice(0, MODULE_LIST_CAP),
    ...(list.length > MODULE_LIST_CAP ? { truncated: `showing ${MODULE_LIST_CAP} of ${list.length}` } : {}),
  });
  const symbolsOfModule = g.symbols.filter((s) => s.module === m.id)
    .sort((a, b) => a.line - b.line || a.id.localeCompare(b.id))
    .map((s) => ({ name: s.name, kind: s.kind, line: s.line, exported: s.exported, refCount: s.refCount }));
  const importsOut = g.edges.filter((e) => e.kind === "imports" && e.from === m.id)
    .map((e) => ({ to: e.to, confidence: e.confidence })).sort((a, b) => a.to.localeCompare(b.to));
  const importedBy = g.edges.filter((e) => e.kind === "imports" && e.to === m.id)
    .map((e) => ({ from: e.from, confidence: e.confidence })).sort((a, b) => a.from.localeCompare(b.from));
  const symbolIds = new Set(g.symbols.filter((s) => s.module === m.id).map((s) => s.id));
  const callsOut = g.edges.filter((e) => e.kind === "calls" && symbolIds.has(e.from) && !symbolIds.has(e.to))
    .map((e) => ({ from: e.from, to: e.to })).sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  const callsIn = g.edges.filter((e) => e.kind === "calls" && symbolIds.has(e.to) && !symbolIds.has(e.from))
    .map((e) => ({ from: e.from, to: e.to })).sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  return {
    text: envelope(ctx, {
      id: m.id, path: m.path, repo: g.repo, loc: m.loc,
      hub: m.hub ?? false, degree: m.degree ?? 0,
      neighborhood: m.neighborhood != null
        ? g.neighborhoodLabels?.[String(m.neighborhood)] ?? `#${m.neighborhood}` : null,
      symbols: cap(symbolsOfModule),
      imports: cap(importsOut),
      importedBy: cap(importedBy),
      callsOut: cap(callsOut),
      callsIn: cap(callsIn),
    }),
  };
}

function toolCheckFreshness(ctx: ToolContext): ToolResult {
  const fresh = ctx.freshness.length > 0 && ctx.freshness.every((f) => f.status === "fresh");
  return {
    text: JSON.stringify({
      fresh,
      repos: ctx.freshness,
      ...(fresh ? {} : { advice: "run: gitatlas extract <folder> --if-stale, then retry. unknown means the graph predates fingerprints or its source root is not on this machine." }),
    }, null, 2),
  };
}

export function callTool(name: string, args: Record<string, unknown>, ctx: ToolContext): ToolResult {
  switch (name) {
    case "brief": {
      try {
        return toolBrief(ctx, args);
      } catch (err) {
        return { text: err instanceof Error ? err.message : String(err), isError: true };
      }
    }
    case "scope": return toolScope(ctx, args);
    case "find_symbol": return toolFindSymbol(ctx, args);
    case "module_info": return toolModuleInfo(ctx, args);
    case "check_freshness": return toolCheckFreshness(ctx);
    default: return { text: `unknown tool: ${name}`, isError: true };
  }
}
