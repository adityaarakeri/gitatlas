# repolens

Point it at a folder of repositories. Get one interactive map of your whole system: every repo as a node, and you can tap into any of them, down through modules, down to individual functions and classes. Built for engineers who run 10+ repos in production and have no single picture of how it all fits together.

One command in, one self-contained HTML file out. No server, no cloud, no account. Your code never leaves your machine.

> Working name. The npm package name `repolens` is already taken, so publishing to npm needs a rename or a scoped name like `@yourname/repolens`. The GitHub repo name is unaffected.

## Quick start

Requires Node 22 or newer.

```bash
git clone <this-repo> && cd repolens
npm install
npm run extract -- /path/to/your/repos
```

That's it. Open the generated `index.html` (path printed at the end) in any browser.

Don't have a folder of repos handy? The included fixtures work:

```bash
npm run extract -- fixtures
open fixtures/.repolens/index.html
```

## What you get

- A zoomable map with three depths: group (repos as nodes), module (files and their imports), symbol (functions, classes, methods, inheritance)
- Dark and light themes (barrel and ground glass), following your system preference
- A dashed ring on any symbol with zero references found in its repo. Treat it as a hint, not a verdict: the matching is name-based and repo-local, so a function consumed from another repo through a package will look unused when it isn't
- Node size scaled by symbol count, so the heavy modules are obvious at a glance
- Filter box, keyboard navigation, reduced-motion support



## Instant, deterministic maps

Older versions ran a physics simulation in your browser, so the map wobbled into place and settled a little differently every time you opened it, like actors finding their marks live on stage. Now the blocking is rehearsed in advance: the same simulation runs once at extract time, headless, and the final positions are baked into the graph files. The viewer opens instantly on a finished picture. No wobble, no waiting, and because the extractor sorts every directory walk, the same repo produces pixel-identical coordinates on any machine, any run. Positions being stable data instead of live physics is also the foundation for diffing maps between commits.

The generated HTML is nearly self-contained too. The d3 library gets vendored into the file at build time, so the map renders on a plane, in an air-gapped environment, anywhere. The only network requests left are the two webfonts, and the viewer falls back to system faces when they don't load.

## Jump to anything

Press Cmd+K (or Ctrl+K, or tap the ⌘K chip in the title plate). Type a few letters of any repo, file, class, or function across your entire group, hit enter, and the camera flies to it and pulses it red. Hovering any node dims everything except its direct connections, so you can trace one module's wiring through a dense map without losing your place.

## Call edges: who actually phones whom

Imports tell you who knows whom, like an org chart. Call edges are the phone records: which function actually rings which other function. At the symbol level the gold lines are calls, and they change what everything else means. A hub is now a module the rest of the code genuinely leans on at runtime, not just one that appears in many import statements. Neighborhoods cluster on real coupling, because cross-module call traffic feeds the clustering alongside imports. And the bug scoper walks actual call chains out from a crash instead of guessing by file proximity.

One rule governs all of it: ambiguous callees are dropped, never guessed. When helper() could be three different symbols, repolens emits no edge rather than a wrong one. Resolution prefers a match in the same file, then accepts a unique match anywhere in the repo, and stays silent otherwise. Every call edge you see is one the extractor would defend.

Call recognition currently covers 13 of the 21 languages: TypeScript, JavaScript, Python, Go, Java, Ruby, C, C++, C#, PHP, Rust, Kotlin, Lua, and Elixir. The rest still get symbols, imports, and inheritance; their call configs are one probed config object away, and CONTRIBUTING shows the shape.

## Neighborhoods and hubs

Open any repo at the module level and you will see shaded regions behind the nodes. Those are neighborhoods, and nobody drew them. Think of a city map: there is no official border around the restaurant district, it exists because those streets connect to each other more than they connect to anywhere else. The clustering does the same thing to your import graph. It groups files that lean on each other heavily and touch the rest of the repo lightly, then labels each group with the deepest folder its members share.

The useful part: neighborhoods are computed from structure, not from your directory tree. When a "utils" file has quietly become load-bearing for the billing code, it shows up inside the billing neighborhood no matter which folder it lives in. The map tells you how the code actually organizes itself, which is not always how it was filed.

Modules with a red outer ring are hubs. Same idea as the busiest intersection in town: count how many roads meet at each node, flag anything far above typical. A hub is where a change ripples widest, which makes it the first place to look before a refactor and the last place to edit casually on a Friday.

Both are deterministic. Same repos in, same neighborhoods and hubs out, every single run. No model calls, no randomness, nothing leaves your machine. Under the hood it is greedy modularity clustering with stable ordering (the Louvain approach, single level) and plain degree statistics. We say that precisely because tools in this space love to borrow fancier algorithm names than they implement.

## Scoping a bug to its neighborhood

When you have a stack trace, you usually don't need the whole repo, you need the few functions around the crash. `scope` resolves a trace into the graph and returns the bounded neighborhood, ranked by structural distance. No LLM, no write path, diagnosis only.

```bash
npm run extract -- fixtures
npm run scope -- --trace crash.txt --out fixtures/.repolens
npm run scope -- --symbol charge --out fixtures/.repolens --json   # or anchor on a name
```

It prints the anchor, the ranked suspects with file:line, and a caveat it means every time: this ranks by how *close* code sits to the symptom, not by how likely it is to be the cause. Bugs where bad data flows through correct-looking code will sit outside the set. It scopes context for you or an agent to reason over. It does not claim to have found the bug.

## Pointing it at real structures

The extractor figures out your layout on its own:

```bash
npm run extract -- ~/work/repos              # flat folder of repos
npm run extract -- ~/work/org                # nested: org/team-a/repo-x found at any depth
npm run extract -- ~/work/repos/one-repo     # a single repo works too
```

Discovery scans for `.git` markers with no depth limit, stopping inside each repo it finds. The brake is a scanned-directory budget (25,000 by default) so pointing it at your home directory by accident won't run away. Raise it with `--max-scan 100000`, or cap depth explicitly with `--depth 3` if you want the old-fashioned limit.

Git submodules are handled, with three modes:

```bash
npm run extract -- ~/work/repos                       # split: each submodule is its own node (default)
npm run extract -- ~/work/repos --submodules absorb   # submodule code counts as part of the parent
npm run extract -- ~/work/repos --submodules skip     # ignore submodule paths entirely
```

Split mode dedupes a submodule vendored into multiple parents and warns about uninitialized ones instead of silently showing hollow nodes.

Build artifacts are pruned so the map shows code, not clutter. `node_modules`, `dist`, `build`, `target`, `vendor`, `__pycache__`, every dot-directory, and package-metadata folders like `mypkg.egg-info` and `foo-1.0.dist-info` are skipped automatically. Add project-specific globs with `--ignore`, repeatable, matched against each entry's name and its repo-relative path:

```bash
npm run extract -- ~/work/repos --ignore '*.min.js' --ignore 'docs/**'   # drop minified files and the whole docs tree
```

`*` and `?` stop at path separators, `**` crosses them, and a trailing `/​**` (as in `docs/**`) also matches the directory itself.

## Honest limitations

- **21 languages.** TypeScript and JavaScript go through the TypeScript compiler API. The other 19 go through tree-sitter grammars compiled to WebAssembly: TS, JS, Python, Go, Ruby, Java, C, C++, C#, PHP, Rust, Kotlin, Swift, Dart, Scala, Lua, Bash, Elixir, Objective-C, OCaml, and Zig. Think of tree-sitter as a record player and each grammar as a disc: one runtime, twenty discs, and adding a language means loading another disc rather than building another player. Because the discs are prebuilt .wasm files, there is still not one native compilation step in the install, which is what keeps Windows machines happy.
- **Each language keeps its own idea of private.** Python and Dart underscores, Go capitalization, Rust pub, Java and C# public keywords, C static meaning file-local, Elixir defp, Lua local functions. The extractor respects the convention of the language instead of forcing everything through one lens. Rust impl methods attach to their type, Objective-C @implementation methods attach to their @interface, Elixir defs become methods of their defmodule.
- **A gap detector guards it all.** One test iterates every registered language and fails CI if any of them has no fixture or extracts zero symbols. Language number 22 cannot be added half-working, the suite will not let it.
- **No cross-repo edges yet.** Repo A calling repo B over HTTP is invisible to static analysis without boundary stitching. That's the v0.3 stitcher (route and topic matching with confidence scores).
- **The viewer's fonts load from Google Fonts.** d3 is vendored into the HTML at build time, so the map itself renders offline; only the type falls back to system faces. Vendoring the fonts for a fully air-gapped build is a welcome PR.
- **Node 24 needs a V8 flag.** Node 24's turboshaft wasm pipeline crashes compiling tree-sitter grammars ([nodejs/node#63421](https://github.com/nodejs/node/issues/63421)). The CLI and npm scripts pass `--liftoff-only` automatically; if you embed the extractor as a library, run node with that flag yourself.
- Reference counting is identifier-name matching, not type-resolved. CommonJS require() and re-export barrels produce no edges yet. Good enough to surface candidates, not good enough to delete code on.

## How it works

```
folder of repos
      |
      v
extractor          one pass per repo, TS compiler API + tree-sitter WASM, zero native deps
      |
      v
RepoGraph JSON     versioned, language-agnostic schema (packages/schema)
+ GroupManifest
      |
      v
index.html         data embedded into the viewer template, opens anywhere
```

Three design rules hold everywhere:

1. **The schema is the contract.** Extractors are plugins that emit the same JSON shape regardless of language. Break the shape, bump the version.
2. **Artifacts are files.** No daemon, no database, no index server. Everything is diffable, committable, CI-friendly.
3. **Every edge carries confidence.** `exact`, `resolved`, or `inferred`. Anything guessed is drawn dashed and labeled as inferred, never presented as fact.

## Roadmap

- cross-repo stitcher: HTTP routes and clients, queue topics, shared-package joins
- touchpoint inventory per repo: env vars, databases, third-party SDKs
- proper multi-level clustering (aggregation with self-loop handling) if large repos show fragmented neighborhoods
- watch mode, incremental re-extraction, MCP server for AI agents

Already shipped: call edges (0.9.0), precomputed deterministic layout and the command palette (0.8.0), 21 languages (0.7.0), neighborhoods and hubs (0.6.0), the `scope` bug scoper (0.4.0).


## Put it in every repo

The whole tool is one command with no setup, which makes it cheap to adopt as a default:

```bash
npm install -g <this-repo>     # or npx once published
repolens extract .             # from any repo root
```

For CI, copy `examples/github-action.yml` into `.github/workflows/repolens.yml` and every push to main regenerates the map as a downloadable artifact. Point the upload step at GitHub Pages instead and the architecture map becomes a living URL your team can bookmark. Because the output is one HTML file, there is nothing to host, patch, or keep alive.

If you want it truly everywhere, add the extract step to your repo template or your org's scaffolding tool, the same slot where LICENSE and CI config already get stamped in.

## Prior art

GitNexus and CodeGraph build deep per-repo knowledge graphs for AI agents. Structurizr renders the C4 zoom ladder beautifully but you declare the model by hand. Sourcegraph navigates across repos at enterprise scale. None of them auto-generate a zoomable system-to-symbol map from a folder of repos as one local HTML file. That gap is the reason this exists.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md). The most valuable contribution right now is a new language extractor, and the doc walks through exactly what one has to emit.

## License

MIT
