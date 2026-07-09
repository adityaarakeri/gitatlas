/**
 * Precomputed layout. The viewer used to run a physics simulation live in
 * the browser, so the map wobbled into place and settled slightly
 * differently every open. This module runs the exact same simulation once,
 * headless, at extract time, and bakes the final coordinates into the graph
 * JSON. The viewer just draws.
 *
 * Determinism: d3-force is deterministic given a stable node order (it
 * places nodes on a phyllotaxis spiral and uses a seeded internal RNG), and
 * the extractor sorts every directory walk, so the same repo produces the
 * same picture on every machine, every run. That also makes positions
 * diffable, which future diff-mode builds on.
 */
const d3f = require("d3-force");

/** abstract canvas the layout is computed on; the viewer fits-to-view anyway */
export const LAYOUT_W = 1600;
export const LAYOUT_H = 1000;

export interface LayoutNode { id: string; r: number; anchor?: { x: number; y: number } }
export interface LayoutLink { source: string; target: string }

export function computeLayout(
  nodes: LayoutNode[], links: LayoutLink[],
): Map<string, { x: number; y: number }> {
  if (nodes.length === 0) return new Map();
  const sorted = [...nodes].sort((a, b) => a.id.localeCompare(b.id));
  const sim = d3f.forceSimulation(sorted)
    .force("link", d3f.forceLink(links.map((l) => ({ ...l }))).id((d: any) => d.id).distance(95))
    .force("charge", d3f.forceManyBody().strength(-330 * Math.min(1, 30 / Math.max(sorted.length, 1))))
    .force("x", d3f.forceX((d: any) => d.anchor?.x ?? LAYOUT_W / 2).strength(d3fXStrength))
    .force("y", d3f.forceY((d: any) => d.anchor?.y ?? LAYOUT_H / 2).strength(d3fXStrength))
    .force("collide", d3f.forceCollide().radius((d: any) => d.r + 24))
    .stop();
  sim.tick(300);
  const out = new Map<string, { x: number; y: number }>();
  for (const n of sorted as any[]) {
    out.set(n.id, { x: Math.round(n.x * 100) / 100, y: Math.round(n.y * 100) / 100 });
  }
  return out;
}
function d3fXStrength(d: any) { return d.anchor ? 0.08 : 0.07; }

/** ring of anchor points, one per neighborhood, mirroring the old viewer math */
export function neighborhoodAnchors(ids: number[]): Map<number, { x: number; y: number }> {
  const anchors = new Map<number, { x: number; y: number }>();
  const R = Math.min(LAYOUT_W, LAYOUT_H) / 4;
  ids.forEach((n, i) => {
    const a = (i / ids.length) * 2 * Math.PI - Math.PI / 2;
    anchors.set(n, { x: LAYOUT_W / 2 + R * Math.cos(a), y: LAYOUT_H / 2 + R * Math.sin(a) });
  });
  return anchors;
}
