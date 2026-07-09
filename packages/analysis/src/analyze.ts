/**
 * Graph analysis: neighborhoods and hubs. Pure functions, deterministic by
 * construction, no randomness anywhere.
 *
 * Neighborhoods: greedy modularity clustering in the Louvain style, with
 * nodes visited in sorted order and ties broken by smallest community id so
 * the same graph always yields the same result. This is Louvain phase one
 * plus one aggregation round, not full Leiden; Leiden's refinement step
 * matters on graphs orders of magnitude larger than a repo's module graph.
 *
 * Hubs: plain degree counting with a robust threshold (mean plus two
 * standard deviations, floor of 4). A hub is where changes ripple widest.
 */

export interface AnalysisEdge { from: string; to: string; }

/** undirected weighted adjacency, self-loops dropped, parallel edges summed */
function adjacency(nodes: string[], edges: AnalysisEdge[]): Map<string, Map<string, number>> {
  const set = new Set(nodes);
  const adj = new Map<string, Map<string, number>>();
  for (const n of nodes) adj.set(n, new Map());
  for (const e of edges) {
    if (e.from === e.to || !set.has(e.from) || !set.has(e.to)) continue;
    adj.get(e.from)!.set(e.to, (adj.get(e.from)!.get(e.to) ?? 0) + 1);
    adj.get(e.to)!.set(e.from, (adj.get(e.to)!.get(e.from) ?? 0) + 1);
  }
  return adj;
}

/** one round of greedy local moving; returns community assignment */
function localMove(
  nodes: string[], adj: Map<string, Map<string, number>>,
): Map<string, number> {
  const sorted = [...nodes].sort();
  const community = new Map<string, number>(sorted.map((n, i) => [n, i]));
  const degree = new Map<string, number>();
  let m2 = 0; // 2 * total edge weight
  for (const n of sorted) {
    let d = 0;
    for (const w of adj.get(n)!.values()) d += w;
    degree.set(n, d);
    m2 += d;
  }
  if (m2 === 0) return community;
  const commTot = new Map<number, number>();
  for (const n of sorted) {
    const c = community.get(n)!;
    commTot.set(c, (commTot.get(c) ?? 0) + degree.get(n)!);
  }

  let moved = true;
  let guard = 0;
  while (moved && guard++ < 50) {
    moved = false;
    for (const n of sorted) {
      const current = community.get(n)!;
      const ki = degree.get(n)!;
      // weight from n into each neighboring community
      const into = new Map<number, number>();
      for (const [nb, w] of adj.get(n)!) {
        const c = community.get(nb)!;
        into.set(c, (into.get(c) ?? 0) + w);
      }
      commTot.set(current, commTot.get(current)! - ki);
      let bestC = current;
      let bestGain = (into.get(current) ?? 0) - (ki * commTot.get(current)!) / m2;
      const candidates = [...into.keys()].sort((a, b) => a - b);
      for (const c of candidates) {
        if (c === current) continue;
        const gain = (into.get(c) ?? 0) - (ki * (commTot.get(c) ?? 0)) / m2;
        if (gain > bestGain + 1e-12) { bestGain = gain; bestC = c; }
      }
      commTot.set(bestC, (commTot.get(bestC) ?? 0) + ki);
      if (bestC !== current) { community.set(n, bestC); moved = true; }
    }
  }
  return community;
}

/**
 * Detect neighborhoods: single-level greedy local moving, then stable
 * renumbering. Aggregation rounds (the part that makes Louvain multi-level)
 * are deliberately absent: doing them correctly requires carrying
 * intra-community weight as self-loops, and doing them incorrectly merges
 * everything. Module graphs are small enough that phase one converges to
 * the right neighborhoods on its own. If fragmentation shows up on very
 * large repos, proper aggregation is the known fix and belongs in a PR with
 * self-loop handling and a failing test first.
 */
export function detectNeighborhoods(
  nodes: string[], edges: AnalysisEdge[],
): Map<string, number> {
  if (nodes.length === 0) return new Map();
  const adj = adjacency(nodes, edges);
  const community = localMove(nodes, adj);

  // stable renumbering: community containing the alphabetically first node is 0
  const firstMember = new Map<number, string>();
  for (const n of [...nodes].sort()) {
    const c = community.get(n)!;
    if (!firstMember.has(c)) firstMember.set(c, n);
  }
  const order = [...firstMember.entries()].sort((a, b) => a[1].localeCompare(b[1])).map(([c]) => c);
  const renum = new Map(order.map((c, i) => [c, i]));
  const out = new Map<string, number>();
  for (const [n, c] of community) out.set(n, renum.get(c)!);
  return out;
}

/**
 * Label each neighborhood by the deepest directory prefix its members share,
 * falling back to the most common top folder, then to "neighborhood N".
 */
export function labelNeighborhoods(
  assignment: Map<string, number>, pathOf: (id: string) => string,
): Map<number, string> {
  const members = new Map<number, string[]>();
  for (const [id, c] of assignment) {
    if (!members.has(c)) members.set(c, []);
    members.get(c)!.push(pathOf(id));
  }
  const labels = new Map<number, string>();
  for (const [c, paths] of members) {
    const split = paths.map((p) => p.split("/").slice(0, -1)); // dirs only
    let prefix = split[0] ?? [];
    for (const parts of split.slice(1)) {
      let i = 0;
      while (i < prefix.length && prefix[i] === parts[i]) i++;
      prefix = prefix.slice(0, i);
    }
    if (prefix.length) { labels.set(c, prefix.join("/")); continue; }
    const tops = new Map<string, number>();
    for (const p of paths) {
      const top = p.includes("/") ? p.split("/")[0] : ".";
      tops.set(top, (tops.get(top) ?? 0) + 1);
    }
    const best = [...tops.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    labels.set(c, best && best[0] !== "." ? best[0] : `neighborhood ${c}`);
  }
  return labels;
}

/**
 * Degree per node and hub flags. Threshold: mean + 2 * stddev, floor 4,
 * and a node needs at least 3 distinct neighbors to ever qualify, so tiny
 * graphs never produce meaningless hubs.
 */
export function findHubs(
  nodes: string[], edges: AnalysisEdge[],
): { degree: Map<string, number>; hubs: Set<string> } {
  const adj = adjacency(nodes, edges);
  const degree = new Map<string, number>();
  for (const n of nodes) degree.set(n, adj.get(n)!.size); // distinct neighbors
  const values = [...degree.values()];
  const mean = values.reduce((a, b) => a + b, 0) / Math.max(values.length, 1);
  const std = Math.sqrt(values.reduce((a, v) => a + (v - mean) ** 2, 0) / Math.max(values.length, 1));
  const threshold = Math.max(4, mean + 2 * std);
  const hubs = new Set<string>();
  for (const [n, d] of degree) {
    if (d >= threshold && d >= 3) hubs.add(n);
  }
  return { degree, hubs };
}
