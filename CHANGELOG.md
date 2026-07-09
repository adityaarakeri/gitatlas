# Changelog

## Unreleased
- Node 24 crash fixed: V8's turboshaft wasm pipeline fatally zone-OOMs while compiling tree-sitter grammars (nodejs/node#63421), killing extraction mid-run. The bin entry re-execs node with `--liftoff-only` on Node 24+, npm test runs single-process with the flag, and the engine warns library consumers who run without it. Engines bumped to Node >=22 (20 is EOL); CI now tests 22 and 24
- WASM heap hygiene: per-file trees and parsers are now disposed after extraction; they live outside the JS heap where the GC cannot reclaim them
- `LangDef` now declares the `calls` and `textImports` hooks it already used at runtime, and the schema declares the baked layout coordinates (`x`/`y`) on modules and symbols
- README corrections: the viewer's webfonts still load from Google Fonts (d3 is vendored, the map itself renders offline), roadmap reflects what has shipped, and the npm name `repolens` is noted as taken
- Build-artifact pruning hardened: package-metadata dirs whose name carries the package prefix (`mypkg.egg-info`, `foo-1.0.dist-info`, `.egg`) are now skipped by suffix, plus `htmlcov` and `site-packages`; a single `shouldSkipDir` predicate governs both file-walking and repo discovery
- New `--ignore <glob>` extract flag (repeatable) for project-specific pruning, matched against each entry's name and repo-relative path; supports `*`, `?`, `**`, and trailing `/​**` that also matches the directory itself
- Three new tests covering artifact-dir skipping, custom-glob pruning, and the glob compiler; ordered ahead of the grammar-heavy polyglot test

## 0.9.0
- Call edges, the missing spine since v0.1: real invocation edges between symbols for 13 languages (TS, JS, Python, Go, Java, Ruby, C, C++, C#, PHP, Rust, Kotlin, Lua, Elixir)
- Honesty rule enforced in the resolver: same-module match, then unique repo-wide match, ambiguous callees dropped rather than guessed; every call edge ships with resolved confidence
- Calls attribute to their enclosing symbol in both engines, including TS arrow functions and constructor calls, Go receiver methods through selectors, and Elixir defs inside their module
- Cross-module call traffic now feeds neighborhood clustering and hub detection alongside imports, so hubs mean "leaned on at runtime" rather than "mentioned in imports"
- The bug scoper walks real call chains automatically, since it reads graph edges
- Symbol-level layout and viewer show call wiring as gold lines with a legend explanation
- Hygiene from the audit: package-lock.json is now committed and CI installs with npm ci for reproducible builds
- Five new call tests including cross-language well-formedness; suite now 53

## 0.8.0
- Precomputed deterministic layout: the force simulation now runs headless at extract time and coordinates ship inside the graph JSON; the viewer opens instantly on a finished, wobble-free picture that is identical on every machine
- Directory walks and repo discovery are now sorted, fixing a latent cross-OS reproducibility gap and anchoring layout determinism
- Generated HTML is fully self-contained: d3 is vendored into the file at build time, zero network requests, works air-gapped
- Command palette: Cmd+K or the title-plate chip, fuzzy search across every repo, module, and symbol in the group, camera flies to the target and pulses it
- Ego highlight: hovering a node dims everything except its direct connections
- Viewer dropped its live physics simulation entirely; dragging repositions nodes directly
- Two new layout tests including run-to-run coordinate equality; suite now 48

## 0.7.0
- 15 new languages: C, C++, C#, PHP, Rust, Kotlin, Swift, Dart, Scala, Lua, Bash, Elixir, Objective-C, OCaml, Zig. Total coverage: 21 languages
- Engine generalized with three hooks: containerOf (Rust impl and ObjC @implementation set method context without declaring a symbol), match (fully custom recognition for Elixir macro-call definitions and OCaml let bindings), and classGuard (C/C++ struct references vs declarations)
- Every config written against probed parse trees, not guesses; language-true visibility everywhere (static, pub, defp, local, underscores, capitalization, public keywords)
- Fresh parser per file: a mis-parsing file can no longer poison extraction of the files after it
- textImports fallback hook for grammars with scanner bugs (lua wasm mis-parses dots inside require strings)
- Gap detector test: iterates every registered language, fails CI on missing fixtures or zero-symbol configs; 16 new polyglot tests, full suite now 46
- Runtime moved to web-tree-sitter 0.25.x to span both grammar ABI generations in the wasm pack

## 0.6.0
- Neighborhood detection: deterministic greedy modularity clustering over each repo's import graph, rendered as labeled hulls at the module level with per-neighborhood layout anchors
- Hub detection: degree-based flagging (mean plus two standard deviations, floored) with a red outer ring and plain-language explanation in the readout
- Honest algorithm naming: single-level Louvain-style local moving, documented as such; flawed aggregation was removed rather than shipped after it failed the barbell test
- Analysis lives in its own package of pure functions with 7 tests (barbell split, input-order determinism, stable renumbering, label prefixes, hub thresholds); full suite now 30 tests
- Global bin: `repolens extract .` and `repolens scope ...` work as commands after global install
- examples/github-action.yml: drop-in CI recipe that regenerates the map on every push

## 0.5.0
- Multi-language extraction: Python, Go, Ruby, and Java join TypeScript/JavaScript
- New tree-sitter WASM engine: prebuilt grammars, no native builds, per-language config objects for symbols, visibility rules, inheritance, and import resolution
- Language-true semantics: Python underscore privacy, Go capitalization exports and receiver methods, Java public/private modifiers, Ruby require_relative resolution, go.mod module-path resolution
- Extraction refactored into an importable library (extract.ts); the CLI is now a thin orchestrator
- Extractor test suite added: 7 tests across all five languages, full suite now 23 tests
- Manifest and viewer surface each repo's detected languages
- web-tree-sitter pinned to 0.24.x for ABI compatibility with prebuilt grammars

## 0.4.1
- Extractor now captures arrow functions and function expressions assigned to variables (`const handler = () => {}`), the dominant style in modern TS codebases
- Theme control replaced with a segmented BARREL / GLASS switch that shows the surface you are on; no more guessing which side is active
- Theme now applies before first paint, killing the dark flash for light-mode users
- Panels transition smoothly on theme switch
- Honest empty state when descending into a repo with no indexed modules (unsupported language) instead of a blank canvas
- Scoper no longer spends hops on phantom nodes: inheritance edge targets resolve to real symbol ids or get dropped
- Added CI workflow, CHANGELOG, .editorconfig

## 0.4.0
- New `scope` command: resolves a stack trace or symbol name into the graph and returns a bounded, ranked structural neighborhood. Diagnosis-only by construction; prints its own limitations every run
- 16-test unit suite for the scoper core on Node's built-in runner, zero new dependencies

## 0.3.x
- Full visual redesign: optical-instrument identity, focus scale navigation, barrel and ground-glass themes, viewfinder brackets
- Bottom bar layout fix: legend and scale share one flow container, framing respects chrome insets
- GitHub readiness: rewritten README, CONTRIBUTING with the extractor plugin contract, MIT license

## 0.2.x
- Auto-generated self-contained viewer HTML on every extract
- Drift containment: positioning forces plus auto fit-to-view
- Unused-symbol indicator backed by repo-local reference counting
- Label halo fix for light backgrounds

## 0.1.x
- TS/JS extractor, versioned graph schema, zoomable three-level viewer
- Repo discovery at any depth with a scanned-directory budget
- Git submodule handling: split, absorb, or skip
