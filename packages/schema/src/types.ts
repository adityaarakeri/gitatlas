/**
 * gitatlas graph schema v0.1
 *
 * Design constraints:
 * - Language-agnostic: extractors for any language emit this same shape.
 * - Versioned: schemaVersion gates breaking changes.
 * - Layered: L0 group -> L1 repo -> L2 module (file) -> L3 symbol.
 * - Edges carry confidence so inferred links are never presented as facts.
 */

export const SCHEMA_VERSION = "0.1.0";

export type SymbolKind =
  | "function"
  | "class"
  | "method"
  | "interface"
  | "type"
  | "enum"
  | "variable";

export type EdgeKind =
  | "imports" // module -> module
  | "calls" // symbol -> symbol (v0.2)
  | "extends" // class -> class
  | "implements" // class -> interface
  | "http_call" // repo -> repo (stitched, v0.3)
  | "publishes" // repo -> topic (v0.3)
  | "consumes"; // topic -> repo (v0.3)

export type Confidence = "exact" | "resolved" | "inferred";

export interface SymbolNode {
  id: string; // repo:module:name
  name: string;
  kind: SymbolKind;
  module: string; // module id
  line: number;
  exported: boolean;
  /**
   * identifier occurrences in the repo beyond the declaration itself.
   * Name-based matching, so treat 0 as "no references found in indexed
   * code" (inferred), not proof of dead code: cross-repo consumers and
   * dynamic dispatch are invisible to it.
   */
  refCount?: number;
  /** for methods, the parent class symbol id */
  parent?: string;
  /** layout coordinates, baked in at extract time (absent pre-0.8 graphs) */
  x?: number;
  y?: number;
}

export interface ModuleNode {
  id: string; // repo:relative/path.ts
  path: string; // relative path within repo
  repo: string;
  symbolCount: number;
  loc: number;
  /** neighborhood id from deterministic modularity clustering (absent pre-0.6 graphs) */
  neighborhood?: number;
  /** distinct import/call neighbors */
  degree?: number;
  /** unusually high degree: where changes ripple widest */
  hub?: boolean;
  /** layout coordinates, baked in at extract time (absent pre-0.8 graphs) */
  x?: number;
  y?: number;
}

export interface Edge {
  from: string;
  to: string;
  kind: EdgeKind;
  confidence: Confidence;
}

export interface RepoGraph {
  schemaVersion: string;
  repo: string;
  root: string;
  language: string[];
  generatedAt: string;
  /**
   * sha256 over the sorted (repo-relative path, content sha256) pairs of
   * every file that entered this graph. `gitatlas check` re-walks the source
   * and compares against this to detect a stale graph before anyone (a human,
   * an agent) trusts its file:line data. Additive; absent in older graphs,
   * which `check` reports as unknown and treats as stale.
   */
  sourceFingerprint?: string;
  modules: ModuleNode[];
  symbols: SymbolNode[];
  edges: Edge[];
  /** neighborhood id -> human label (deepest shared directory) */
  neighborhoodLabels?: Record<string, string>;
}

export interface GroupManifest {
  schemaVersion: string;
  group: string;
  generatedAt: string;
  repos: {
    name: string;
    graphFile: string;
    moduleCount: number;
    symbolCount: number;
    languages?: string[];
    /** layout coordinates for the group view, baked in at extract time */
    x?: number;
    y?: number;
  }[];
  /** cross-repo edges, stitched in v0.3; empty in v0.1 */
  edges: Edge[];
}
