# Changelog

## Unreleased
- The viewer UI is translatable, and ships in English, `zh-CN`, `ja`, `es`, and `pt-BR`. Catalogs are flat JSON at `packages/viewer/locales/<code>.json` and every one is baked into the generated file, so a single map can be opened by a mixed-language team; the file picks the reader's browser language on open, falls back to English, and shows a picker beside the theme toggle when it carries more than one language. `gitatlas extract --lang <code>` pins the default instead, and an unknown code lists the ones that exist. Schema values stay English on the wire and are translated only where they are displayed, so graph JSON is byte-identical whatever `--lang` says. Plurals go through `Intl.PluralRules` rather than an English `n === 1` test, which is what the badge under a directory was doing. Only English is human-reviewed: the other four carry `reviewed: false` and are labeled machine drafts in `docs/i18n.md`, and a test refuses `reviewed: true` without a named maintainer
- Viewer: the plate wraps instead of running off the screen on a phone, which it was already close to doing before the locale picker was added to it
- Viewer: catalog text and indexed symbol names are HTML-escaped where they reach `innerHTML` (the legend, the detail panel, and the command palette)

## 0.11.0 - 2026-08-09
- `--ref <branch|tag|commit>` pins which commit of a GitHub target is mapped, and a `/tree/<ref>/` or `/blob/<ref>/` URL is read as naming that ref (the flag wins when both are given, and the disagreement is printed). Each ref gets its own clone at `<repo>@<ref>`, which is also the name its map carries, so mapping a branch never disturbs the default branch's map and the two cannot be confused; a rewritten ref slug carries a hash of the original so two refs can never share a clone. Refs are validated against a subset of `git check-ref-format` before git sees them, which also keeps a ref from arriving as a git option. `check`, `brief`, `mcp`, and `scope` take the same flag; `--ref` against a local folder is an error, not a silent no-op
- `brief`, `mcp`, and `scope` take `--target <folder|github-repo>`, the same input `extract` was given, and read the map it wrote: no pasting the cache path. Path resolution only, so naming a repo here never clones or fetches; `--out` still names a map directory and wins when both are given. `--cache-dir` on all three for a moved cache
- `extract` and `check` now take a GitHub repo as well as a folder: `owner/repo`, `github.com/owner/repo`, a browser URL, or an scp-style `git@github.com:owner/repo.git`. The repo is shallow-cloned to `~/.gitatlas/repos/<owner>/<repo>` (move it with `--cache-dir` or `GITATLAS_CACHE_DIR`) and refreshed in place on later runs, so `check` and `--if-stale` work against a moving upstream. A path that exists on disk always wins, so no invocation that worked before starts reaching for the network, and a bare `owner/repo` guess is announced when it is made. Parsing lives in `packages/extractor/src/github.ts` (pure, now shared with the playground) and cloning in `clone.ts`
- `npm test` fixed on Node 22: the script hardcoded `--test-isolation=none`, which only exists from Node 24 (Node 22 spells it `--experimental-test-isolation`), so the suite died at startup with `node: bad option: --test-isolation=none` and the Node 22 CI leg never ran a test. The command now goes through `scripts/test.mjs`, which asks node which spelling it accepts, keeps the single-process mode the tree-sitter grammars need, and adds `--liftoff-only` on Node 24+
- `npm test -- <file>` runs a single test file with the same flags
- Site hero chart corrected: the stylized map is one repo at module level, so its files are now one language instead of five, and the confidence legend no longer stretches each swatch line across its own label (`.chart-frame svg` was sizing the legend swatches to 100% width along with the map)

## 0.10.0 - 2026-08-03
- First npm release: `npm install -g gitatlas` or `npx gitatlas`. The tarball ships compiled CommonJS in `dist/` plus the viewer template; `bin/gitatlas.js` prefers `dist/` and falls back to running the TypeScript sources through tsx from a clone, so contributor quick start is unchanged
- `typescript` is now a runtime dependency: the TS/JS extractor calls the compiler API at extraction time, so a published install needs it (it was previously a devDependency, which only worked from a clone)
- Renamed from repolens to gitatlas ahead of the first release. The command is `gitatlas`, the entry point is `bin/gitatlas.js`, the default output directory is `.gitatlas`, the playground cache is `.gitatlas-site`, and the playground environment variables are `GITATLAS_SITE_*`. A hard cut with no aliases: nothing had been published under the old name, so there was nothing to migrate. Existing local `.repolens` maps are not read; delete them and re-extract
- New `gitatlas brief` command (`packages/brief`): compresses the map into a token-budgeted markdown digest for agent context, per repo: hubs, neighborhoods, largest modules, key exports with file:line. Detail sections drop to fit `--budget` and every cut is announced in the text; pure builder in `brief.ts`, I/O in `cli.ts`, mirroring the scoper split
- New `gitatlas mcp` command (`packages/mcp`): a dependency-free MCP server over stdio with five tools: `brief`, `scope`, `find_symbol`, `module_info`, `check_freshness`. Reloads graphs when group.json changes on disk; re-verifies source fingerprints (60s cache) before every tool call and flags stale repos inside each result, so an agent never consumes unmarked stale file:line data
- Shared `graphFreshness` helper (`packages/extractor/src/freshness.ts`) validates existing graphs against their recorded source roots; `parseGitmodules` moved there from the extract CLI
- Schema types now declare what graphs already carry: `neighborhood`/`degree`/`hub` on modules, `neighborhoodLabels` on graphs, `languages` and layout coordinates on manifest repo entries. Additive alignment, no version bump
- Nine new tests (brief determinism, budget trimming, filtering, staleness flagging; MCP handshake, all tools, freshness gate flip)
- Staleness detection: every graph now records a `sourceFingerprint`, a sha256 over the sorted (path, content hash) pairs of the files that entered it. Content-based, so the same tree fingerprints identically on any machine; additive schema field, no version bump
- New `gitatlas check <group-folder>` command: re-walks the source with the same discovery rules and compares fingerprints against the existing map. Per-repo status (fresh / stale / new / removed / unknown), `--json` for scripts and agents, exit 0 fresh / 1 stale, no parsing and no writes
- New `extract --if-stale` flag: runs the same comparison first and skips extraction entirely when nothing changed, so CI jobs and agent hooks can run it unconditionally before reading the graphs
- Three freshness additions to the suite: a fingerprint unit test and an end-to-end check / --if-stale lifecycle test
- Command surface wired everywhere the others are: `check`, `brief`, and `mcp` appear in `gitatlas --help` and as npm scripts (`npm run check`, `npm run brief`, `npm run mcp`); README gains a command reference table, a "Knowing when the map is stale" section, and a "Feeding the map to a coding agent" section, with MCP moved off the roadmap
- Extraction crash fixed: a TS/JS relative import of a non-code or missing file (`import "./globals.css"` in any Next.js app) emitted an edge to a module that never exists, and layout died on it (d3 forceLink "node not found"), taking the whole build down. The resolver now only resolves to files the extractor indexes; everything else becomes a `pkg:` edge, same as the tree-sitter languages: the statement is a fact, its target is not
- TS/JS import resolution widened to match what the extractor indexes: `.jsx`, `.mjs`, `.cjs`, `index.tsx` / `index.jsx` candidates, and ESM-style `./x.js` specifiers mapping to `x.ts` on disk
- Merge-time integrity guard: any import edge whose target is neither an indexed module nor a `pkg:` node is dropped with a warning, so a future extractor bug degrades one edge instead of crashing the build
- Playground clones with `core.longpaths=true`: repos with deep trees exceed Windows' 260-char path limit and abort the checkout; ignored on other platforms
- Regression test for dangling import targets (css, missing file, `.jsx`); suite now 72
- Playground deployment recipes: `Dockerfile` (Node 22 + git, cache at `/data` for volume mounts), `render.yaml` one-click free-tier Blueprint, and `fly.toml` scale-to-zero config, with a README section comparing the cheap options
- Hosted playground (`packages/site`, `npm run site`): a dependency-free Node server that maps any public GitHub repo at `/gh/owner/repo`. Shallow clone, size cap, extraction in an isolated child process (crash isolation, per-build WASM memory reclaim, inherits the Node 24 flag handling), maps cached by commit SHA with LRU eviction, landing page with recent maps, build-status polling. Pure logic in `service.ts` with 13 tests; I/O in `server.ts`, mirroring the scoper split
- New landing page: the entire system as one tidy tree, group -> repos -> directories -> files on a single page. Built from data already in the graph files, so picking it up only needs the HTML regenerated, not a re-extraction
- Every tree node acts: a file opens its symbol view, repos and directories fold and unfold on click, and the -> arrow beside a repo or directory dives into its module map (pre-filtered to the directory's path). All of it keyboard-reachable
- Inline badges on tree nodes: languages and symbol count on repos, symbol count on files, file count on directories
- Folding keeps the current pan and zoom, fold state survives trips into the deeper views, and the filter box prunes the tree to matching branches while overriding folds so a match is never hidden
- The depth scale gains a TREE stop ahead of GROUP / MODULE / SYMBOL, and backing out of the group view now returns to the tree
- Node 24 crash fixed: V8's turboshaft wasm pipeline fatally zone-OOMs while compiling tree-sitter grammars (nodejs/node#63421), killing extraction mid-run. The bin entry re-execs node with `--liftoff-only` on Node 24+, npm test runs single-process with the flag, and the engine warns library consumers who run without it. Engines bumped to Node >=22 (20 is EOL); CI now tests 22 and 24
- WASM heap hygiene: per-file trees and parsers are now disposed after extraction; they live outside the JS heap where the GC cannot reclaim them
- `LangDef` now declares the `calls` and `textImports` hooks it already used at runtime, and the schema declares the baked layout coordinates (`x`/`y`) on modules and symbols
- README corrections: the viewer's webfonts still load from Google Fonts (d3 is vendored, the map itself renders offline), roadmap reflects what has shipped, and the npm name `gitatlas` is noted as taken
- Build-artifact pruning hardened: package-metadata dirs whose name carries the package prefix (`mypkg.egg-info`, `foo-1.0.dist-info`, `.egg`) are now skipped by suffix, plus `htmlcov` and `site-packages`; a single `shouldSkipDir` predicate governs both file-walking and repo discovery
- New `--ignore <glob>` extract flag (repeatable) for project-specific pruning, matched against each entry's name and repo-relative path; supports `*`, `?`, `**`, and trailing `/​**` that also matches the directory itself
- Three new tests covering artifact-dir skipping, custom-glob pruning, and the glob compiler; ordered ahead of the grammar-heavy polyglot test

## 0.9.0
- Call edges, the missing spine since v0.1: real invocation edges between symbols for 14 languages (TS, JS, Python, Go, Java, Ruby, C, C++, C#, PHP, Rust, Kotlin, Lua, Elixir)
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
- Global bin: `gitatlas extract .` and `gitatlas scope ...` work as commands after global install
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
