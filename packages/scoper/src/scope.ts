/**
 * scoper core: turn a bug signal into a bounded, ranked neighborhood of the
 * graph. Pure functions only, no file I/O, so every piece is unit-testable.
 *
 * Honest scope: this RETRIEVES the structural neighborhood around a symptom.
 * It does not diagnose root cause. Causal bugs (bad data through correct code)
 * leave no structural trace, so a suspect here means "structurally close to the
 * symptom", never "this is the bug". The CLI prints that caveat every run.
 */

export interface SymbolNode {
  id: string; name: string; kind: string; module: string;
  line: number; exported: boolean; refCount?: number; parent?: string;
}
export interface Edge { from: string; to: string; kind: string; confidence: string; }
export interface RepoGraph {
  repo: string; modules: { id: string; path: string }[];
  symbols: SymbolNode[]; edges: Edge[];
}

export interface TraceFrame { fnName?: string; file?: string; line?: number; }

export interface Suspect {
  id: string; name: string; kind: string; file: string; line: number;
  hops: number; score: number; reasons: string[];
}

export interface ScopeResult {
  anchor: { query: string; resolved: string | null; confidence: string };
  suspects: Suspect[];
  truncated: boolean;
}

/**
 * Parse stack-trace frames from common runtime formats. Recognizes:
 *   V8/Node:   at PaymentService.charge (/abs/payment.ts:42:11)
 *   V8 bare:   at handleCheckout (routes/checkout.ts:5:3)
 *   anon:      at /abs/index.ts:10:1
 * Returns frames in trace order (topmost throwing frame first).
 */
export function parseTrace(text: string): TraceFrame[] {
  const frames: TraceFrame[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("at ")) continue;
    const body = line.slice(3).trim();
    // "fn (loc)" or just "loc"
    const m = body.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
    const fnName = m ? m[1].trim() || undefined : undefined;
    const locStr = m ? m[2] : body;
    const loc = locStr.match(/^(.*?):(\d+)(?::\d+)?$/);
    if (loc) {
      frames.push({ fnName, file: loc[1].trim(), line: parseInt(loc[2], 10) });
    } else if (fnName) {
      frames.push({ fnName });
    }
  }
  return frames;
}

/** basename + a couple of parent segments, for fuzzy path matching across abs/rel */
function pathTail(p: string): string {
  return p.replace(/\\/g, "/").split("/").slice(-2).join("/");
}

/**
 * Resolve a trace frame to a symbol id in the graph. Strategy, most precise
 * first: (1) file + line lands inside a symbol's span, (2) function name +
 * file match, (3) function name alone if unique. Returns id + confidence.
 */
export function resolveFrame(
  frame: TraceFrame, graph: RepoGraph,
): { id: string | null; confidence: string } {
  const byModule = new Map<string, SymbolNode[]>();
  for (const s of graph.symbols) {
    if (!byModule.has(s.module)) byModule.set(s.module, []);
    byModule.get(s.module)!.push(s);
  }
  const moduleForFile = (file: string): string | null => {
    const tail = pathTail(file);
    let best: string | null = null;
    for (const m of graph.modules) {
      if (m.path.endsWith(tail) || pathTail(m.path) === tail) best = m.id;
    }
    return best;
  };
  const bareName = (s: SymbolNode) => (s.name.includes(".") ? s.name.split(".").pop()! : s.name);
  const frameBare = frame.fnName?.includes(".") ? frame.fnName.split(".").pop()! : frame.fnName;

  // (1) file + line: pick the symbol whose declaration line is the closest
  // one at or above the frame line (the enclosing declaration)
  if (frame.file && frame.line != null) {
    const mod = moduleForFile(frame.file);
    if (mod) {
      const candidates = (byModule.get(mod) ?? [])
        .filter((s) => s.line <= frame.line!)
        .sort((a, b) => b.line - a.line);
      // prefer one whose bare name also matches the frame, else nearest decl
      const named = candidates.find((s) => frameBare && bareName(s) === frameBare);
      if (named) return { id: named.id, confidence: "exact" };
      if (candidates.length) return { id: candidates[0].id, confidence: "resolved" };
    }
  }
  // (2) function name + file
  if (frameBare && frame.file) {
    const mod = moduleForFile(frame.file);
    if (mod) {
      const hit = (byModule.get(mod) ?? []).find((s) => bareName(s) === frameBare);
      if (hit) return { id: hit.id, confidence: "resolved" };
    }
  }
  // (3) function name alone, only if unique across the repo
  if (frameBare) {
    const hits = graph.symbols.filter((s) => bareName(s) === frameBare);
    if (hits.length === 1) return { id: hits[0].id, confidence: "inferred" };
  }
  return { id: null, confidence: "none" };
}

/**
 * Build an undirected adjacency map over the graph edges plus class/method
 * containment, so a walk from a method reaches its class and siblings.
 */
export function buildAdjacency(graph: RepoGraph): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (!adj.has(a)) adj.set(a, new Set());
    if (!adj.has(b)) adj.set(b, new Set());
    adj.get(a)!.add(b);
    adj.get(b)!.add(a);
  };
  const byName = new Map<string, string>();
  for (const s of graph.symbols) {
    byName.set(s.name, s.id);
    if (s.parent) link(s.id, s.parent);
  }
  const ids = new Set(graph.symbols.map((s) => s.id).concat(graph.modules.map((m) => m.id)));
  for (const e of graph.edges) {
    if (e.to.startsWith("pkg:")) continue;
    // heritage edges store a bare name as the target; resolve it to a real
    // symbol id, and drop the edge if it points at nothing we indexed
    const to = ids.has(e.to) ? e.to : byName.get(e.to);
    if (!to) continue;
    link(e.from, to);
  }
  return adj;
}

/**
 * BFS out from an anchor to maxHops, capped at maxNodes. Returns each reached
 * symbol with its hop distance.
 */
export function walkNeighborhood(
  anchorId: string, adj: Map<string, Set<string>>,
  maxHops: number, maxNodes: number,
): { reached: Map<string, number>; truncated: boolean } {
  const reached = new Map<string, number>([[anchorId, 0]]);
  let frontier = [anchorId];
  let truncated = false;
  for (let hop = 1; hop <= maxHops && frontier.length; hop++) {
    const next: string[] = [];
    for (const node of frontier) {
      for (const nb of adj.get(node) ?? []) {
        if (reached.has(nb)) continue;
        if (reached.size >= maxNodes) { truncated = true; continue; }
        reached.set(nb, hop);
        next.push(nb);
      }
    }
    frontier = next;
  }
  return { reached, truncated };
}

/**
 * Rank reached symbols into suspects. Score is deterministic:
 *   base    = 1 / (1 + hops)            closer to the symptom ranks higher
 *   churn   = + min(refCount or 0, ...) bonus is intentionally absent here;
 *             churn needs git data the graph doesn't carry, so v1 ranks on
 *             structural distance only and says so. (Hook left for v2.)
 * Ties broken by id for stable output.
 */
export function rankSuspects(
  reached: Map<string, number>, graph: RepoGraph,
): Suspect[] {
  const symById = new Map(graph.symbols.map((s) => [s.id, s]));
  const modPath = new Map(graph.modules.map((m) => [m.id, m.path]));
  const suspects: Suspect[] = [];
  for (const [id, hops] of reached) {
    const s = symById.get(id);
    if (!s) continue;
    const score = 1 / (1 + hops);
    const reasons: string[] = [];
    reasons.push(hops === 0 ? "matched the throwing frame" : `${hops} hop${hops > 1 ? "s" : ""} from the symptom`);
    if (s.refCount === 0) reasons.push("no references found in this repo");
    suspects.push({
      id, name: s.name, kind: s.kind,
      file: modPath.get(s.module) ?? s.module, line: s.line,
      hops, score: Math.round(score * 1000) / 1000, reasons,
    });
  }
  suspects.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return suspects;
}

/** Full pipeline: trace text (or bare symbol name) -> ranked scope result. */
export function scope(
  query: string, graph: RepoGraph,
  opts: { maxHops?: number; maxNodes?: number; topK?: number } = {},
): ScopeResult {
  const maxHops = opts.maxHops ?? 2;
  const maxNodes = opts.maxNodes ?? 40;
  const topK = opts.topK ?? 8;

  const frames = parseTrace(query);
  let anchorId: string | null = null;
  let confidence = "none";

  if (frames.length) {
    for (const frame of frames) {
      const r = resolveFrame(frame, graph);
      if (r.id) { anchorId = r.id; confidence = r.confidence; break; }
    }
  } else {
    // no trace: treat the query as a bare symbol name
    const bare = query.trim();
    const hits = graph.symbols.filter(
      (s) => s.name === bare || (s.name.includes(".") ? s.name.split(".").pop() === bare : false),
    );
    if (hits.length === 1) { anchorId = hits[0].id; confidence = "inferred"; }
    else if (hits.length > 1) { anchorId = hits[0].id; confidence = "ambiguous"; }
  }

  if (!anchorId) {
    return { anchor: { query, resolved: null, confidence }, suspects: [], truncated: false };
  }
  const adj = buildAdjacency(graph);
  const { reached, truncated } = walkNeighborhood(anchorId, adj, maxHops, maxNodes);
  const suspects = rankSuspects(reached, graph).slice(0, topK);
  return { anchor: { query, resolved: anchorId, confidence }, suspects, truncated };
}
