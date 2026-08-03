# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

gitatlas turns a folder of git repositories into one self-contained interactive HTML architecture map (group -> repo -> module -> symbol). No server, no database, no network at runtime. Everything is local files.

## Commands

```bash
npm install                        # no build step, no native deps; code runs through tsx directly
npm test                           # full suite: extractor (all 21 languages), analysis, scoper (Node built-in test runner)
npm run extract -- fixtures        # smoke test: indexes 3+ fixture repos, emits fixtures/.gitatlas/index.html
npm run check -- fixtures          # freshness check against the existing map: exit 0 fresh, 1 stale; --json for machines
npm run extract -- fixtures --if-stale   # re-extract only when source content changed (run before trusting graph data)
npm run brief -- --out fixtures/.gitatlas --budget 1500   # token-budgeted markdown digest for agent context
npm run mcp -- --out fixtures/.gitatlas                   # MCP server over stdio (brief/scope/find_symbol/module_info/check_freshness)
npm run scope -- --trace crash.txt --out fixtures/.gitatlas   # bug scoper (requires a prior extract)
```

Run a single test file:

```bash
npm test -- packages/extractor/test/extract.test.ts
```

`scripts/test.mjs` wires the flags for both: single-process isolation (child test processes crash compiling tree-sitter grammars on Node 24, nodejs/node#63421) plus `--liftoff-only` on Node 24+. The isolation flag is detected, not hardcoded: Node 22 spells it `--experimental-test-isolation`, Node 24 spells it `--test-isolation`, and the wrong spelling is a fatal `node: bad option` at startup.

Requires Node 22+ (22.8+ for the test suite).

## Architecture

Data flows one way: extractor -> JSON graph files -> viewer HTML. The pieces communicate only through the schema.

- `packages/schema/src/types.ts` — the contract. `RepoGraph` + `GroupManifest` JSON shapes, `SCHEMA_VERSION`. Start here for any change.
- `packages/extractor/` — CLI (`cli.ts`): repo discovery (scans for `.git` markers), TS/JS extraction via the TypeScript compiler API, viewer generation (embeds data + vendored d3 into the template). `extract.ts` holds the tree-sitter WASM engine and `SITTER_LANGS`, a per-language config table covering the other 19 languages. `layout.ts` computes node positions at extract time.
- `packages/analysis/` — neighborhoods (single-level Louvain clustering) and hub detection (degree statistics).
- `packages/scoper/` — resolves a stack trace or symbol name into the graph and ranks the surrounding neighborhood. `scope.ts` is pure functions, `cli.ts` is I/O only; mirror that split for new logic.
- `packages/brief/` — token-budgeted markdown digest of the map for agent context (`brief.ts` pure, `cli.ts` I/O). Budget cuts are always announced in the text, never silent.
- `packages/mcp/` — dependency-free MCP server over stdio (`server.ts` tool logic, `cli.ts` JSON-RPC framing). Re-verifies source fingerprints before every tool call and flags stale repos inside each result.
- `packages/viewer/template.html` — the entire viewer: one file, vanilla JS + d3, no framework, no build. Keep it view-source-able.
- `bin/gitatlas.js` — global entry; re-execs with `--liftoff-only` on Node 24+, then dispatches to extractor or scoper CLI via `tsx/cjs`.
- `fixtures/` — small fake repos used by tests and the smoke test; `fixtures/polyglot-lab` has one file per tree-sitter language.

## The three rules (from CONTRIBUTING.md, enforced by tests)

1. **The schema is the contract.** Extractor and viewer never know about each other. Additive schema changes (new optional fields) are fine; breaking changes require bumping `SCHEMA_VERSION`.
2. **Artifacts are files.** No daemon, no database, no required network.
3. **Every edge carries confidence.** `exact` (statically certain), `resolved` (matched within the repo), `inferred` (heuristic). The viewer draws inferred edges dashed. Never upgrade a guess to a fact.

## Determinism is load-bearing

- `layout.ts` and everything in `packages/analysis` must be deterministic: sorted iteration, explicit tie-breaking, no `Math.random`, no wall-clock. Tests assert coordinate equality across runs and identical output on shuffled input. If your change breaks those tests, the change is wrong, not the test.
- Call-edge resolution enforces an honesty rule: same-module match first, unique repo-wide match second, otherwise emit no edge. Never weaken this to boost edge counts.

## Adding or changing a language extractor

- A new language is usually one config object in `SITTER_LANGS` (`packages/extractor/src/extract.ts`): extensions, wasm grammar name (must exist in tree-sitter-wasms), declaration node types, name/exported readers, import resolver. Python, Go, Ruby, and Java are the worked examples.
- The gap detector in `packages/extractor/test/polyglot.test.ts` iterates `SITTER_LANGS` and fails if a registered language has no fixture in `fixtures/polyglot-lab` or extracts zero symbols.
- ID conventions are load-bearing: modules are `repo:relative/path`, symbols are `repo:relative/path:Name`, methods are `Name.method` with `parent` set to the class symbol id.
- Use a fresh parser per file (a mis-parse can poison a reused parser). If a grammar's scanner is buggy, add a `textImports` regex fallback to the config instead of losing edges silently.
- web-tree-sitter and tree-sitter-wasms versions are pinned together; never bump one without the other.
- Unresolvable imports become `pkg:<specifier>` with confidence `exact` (the statement is a fact, its target is not).

## Viewer changes

- Vanilla JS only, single template file. All colors flow through CSS variables; update both themes (`data-theme="dark"` and `"light"`) together.
- Visible focus states and `prefers-reduced-motion` support are non-negotiable; test keyboard navigation and a phone viewport.
- The viewer never simulates layout; it draws the baked coordinates (grid fallback for pre-layout graphs).

## Style

- No em dashes in docs or UI copy; use commas, periods, or restructure.
- UI copy is plain and active ("Tap a node to open it").
- New CLI flags need a README line and a default that preserves current behavior.
- One concern per PR; breaking schema changes must say so and bump `SCHEMA_VERSION`.
