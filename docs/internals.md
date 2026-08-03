# How it works

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

## Instant, deterministic maps

Older versions ran a physics simulation in your browser, so the map wobbled into place and settled a little differently every time you opened it, like actors finding their marks live on stage. Now the blocking is rehearsed in advance: the same simulation runs once at extract time, headless, and the final positions are baked into the graph files. The viewer opens instantly on a finished picture. No wobble, no waiting, and because the extractor sorts every directory walk, the same repo produces pixel-identical coordinates on any machine, any run. Positions being stable data instead of live physics is also the foundation for diffing maps between commits.

The generated HTML is nearly self-contained too. The d3 library gets vendored into the file at build time, so the map renders on a plane, in an air-gapped environment, anywhere. The only network requests left are the two webfonts, and the viewer falls back to system faces when they do not load.

## Call edges: who actually phones whom

Imports tell you who knows whom, like an org chart. Call edges are the phone records: which function actually rings which other function. At the symbol level the gold lines are calls, and they change what everything else means. A hub is now a module the rest of the code genuinely leans on at runtime, not just one that appears in many import statements. Neighborhoods cluster on real coupling, because cross-module call traffic feeds the clustering alongside imports. And the bug scoper walks actual call chains out from a crash instead of guessing by file proximity.

One rule governs all of it: ambiguous callees are dropped, never guessed. When `helper()` could be three different symbols, gitatlas emits no edge rather than a wrong one. Resolution prefers a match in the same file, then accepts a unique match anywhere in the repo, and stays silent otherwise. Every call edge you see is one the extractor would defend.

Call recognition currently covers 14 of the 21 languages: TypeScript, JavaScript, Python, Go, Java, Ruby, C, C++, C#, PHP, Rust, Kotlin, Lua, and Elixir. The rest still get symbols, imports, and inheritance. Their call configs are one probed config object away, and [CONTRIBUTING.md](../CONTRIBUTING.md) shows the shape.

## Neighborhoods and hubs

Open any repo at the module level and you will see shaded regions behind the nodes. Those are neighborhoods, and nobody drew them. Think of a city map: there is no official border around the restaurant district, it exists because those streets connect to each other more than they connect to anywhere else. The clustering does the same thing to your import graph. It groups files that lean on each other heavily and touch the rest of the repo lightly, then labels each group with the deepest folder its members share.

The useful part: neighborhoods are computed from structure, not from your directory tree. When a "utils" file has quietly become load-bearing for the billing code, it shows up inside the billing neighborhood no matter which folder it lives in. The map tells you how the code actually organizes itself, which is not always how it was filed.

Modules with a red outer ring are hubs. Same idea as the busiest intersection in town: count how many roads meet at each node, flag anything far above typical. A hub is where a change ripples widest, which makes it the first place to look before a refactor and the last place to edit casually on a Friday.

Both are deterministic. Same repos in, same neighborhoods and hubs out, every single run. No model calls, no randomness, nothing leaves your machine. Under the hood it is greedy modularity clustering with stable ordering (the Louvain approach, single level) and plain degree statistics. We say that precisely because tools in this space love to borrow fancier algorithm names than they implement.

## Honest limitations

- **21 languages.** TypeScript and JavaScript go through the TypeScript compiler API. The other 19 go through tree-sitter grammars compiled to WebAssembly: Python, Go, Ruby, Java, C, C++, C#, PHP, Rust, Kotlin, Swift, Dart, Scala, Lua, Bash, Elixir, Objective-C, OCaml, and Zig. Think of tree-sitter as a record player and each grammar as a disc: one runtime, nineteen discs, and adding a language means loading another disc rather than building another player. Because the discs are prebuilt `.wasm` files, there is still not one native compilation step in the install, which is what keeps Windows machines happy.
- **Each language keeps its own idea of private.** Python and Dart underscores, Go capitalization, Rust `pub`, Java and C# public keywords, C `static` meaning file-local, Elixir `defp`, Lua local functions. The extractor respects the convention of the language instead of forcing everything through one lens. Rust impl methods attach to their type, Objective-C `@implementation` methods attach to their `@interface`, Elixir defs become methods of their defmodule.
- **A gap detector guards it all.** One test iterates every registered language and fails CI if any of them has no fixture or extracts zero symbols. Language number 22 cannot be added half-working, the suite will not let it.
- **No cross-repo edges yet.** Repo A calling repo B over HTTP is invisible to static analysis without boundary stitching. That is the v0.3 stitcher (route and topic matching with confidence scores).
- **The viewer's fonts load from Google Fonts.** d3 is vendored into the HTML at build time, so the map itself renders offline. Only the type falls back to system faces. Vendoring the fonts for a fully air-gapped build is a welcome PR.
- **Node 24 needs a V8 flag.** Node 24's turboshaft wasm pipeline crashes compiling tree-sitter grammars ([nodejs/node#63421](https://github.com/nodejs/node/issues/63421)). The CLI and npm scripts pass `--liftoff-only` automatically. If you embed the extractor as a library, run node with that flag yourself.
- **Reference counting is identifier-name matching, not type-resolved.** CommonJS `require()` and re-export barrels produce no edges yet. Good enough to surface candidates, not good enough to delete code on.

## Prior art

GitNexus and CodeGraph build deep per-repo knowledge graphs for AI agents. Structurizr renders the C4 zoom ladder beautifully but you declare the model by hand. Sourcegraph navigates across repos at enterprise scale. None of them auto-generate a zoomable system-to-symbol map from a folder of repos as one local HTML file. That gap is the reason this exists.
