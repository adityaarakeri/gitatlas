# gitatlas

Point it at a folder of repositories. Get one interactive map of your whole system: every repo as a node, and you can tap into any of them, down through modules, down to individual functions and classes. Built for engineers who run 10+ repos in production and have no single picture of how it all fits together.

One command in, one self-contained HTML file out. No server, no cloud, no account. Your code never leaves your machine.

> Not published yet. Install from a clone for now; `npm i -g gitatlas` and `brew install` land with the first release. See `PUBLISH.md`.

## Quick start

Requires Node 22 or newer.

```bash
git clone <this-repo> && cd gitatlas
npm install
npm run extract -- /path/to/your/repos
```

That's it. Open the generated `index.html` (path printed at the end) in any browser.

Don't have a folder of repos handy? The included fixtures work:

```bash
npm run extract -- fixtures
open fixtures/.gitatlas/index.html
```

## Command reference

One binary, six commands. From a clone, `npm run <command> --` invokes the same thing (for example `npm run extract -- fixtures`).

| Command | What it does |
| --- | --- |
| `gitatlas extract <folder>` | Build the map: one graph JSON per repo plus the self-contained viewer HTML. Flags: `--out <dir>`, `--ignore <glob>` (repeatable), `--submodules split/absorb/skip`, `--depth N`, `--max-scan N`, `--if-stale` (skip when nothing changed) |
| `gitatlas check <folder>` | Compare source content fingerprints against the existing map, no parsing, no writes. Exit 0 fresh, 1 stale; `--json` for scripts and agents |
| `gitatlas brief` | Token-budgeted markdown digest of the map for agent context. Flags: `--out <dir>`, `--repo <name>`, `--budget <tokens>`, `--ignore <glob>` |
| `gitatlas mcp` | Serve the map to AI agents over MCP on stdio: `brief`, `scope`, `find_symbol`, `module_info`, `check_freshness` tools. Flags: `--out <dir>`, `--ignore <glob>` |
| `gitatlas scope` | Rank the structural neighborhood around a bug signal. `--trace <file>` or `--symbol <name>`, plus `--out <dir>`, `--repo <name>`, `--hops N`, `--top K`, `--json` |
| `gitatlas site` | Start the hosted playground that maps public GitHub repos on demand |

`extract` and `check` default `--out` to `<folder>/.gitatlas`; `brief`, `mcp`, and `scope` default it to `./.gitatlas` in the current directory.

## What you get

- A landing page showing the entire system as one tree: every repo, directory, and file on a single page. Repos carry their languages and symbol counts, files their symbol counts, directories their file counts. Repos and directories fold and unfold on click, and the → beside any of them dives into its map
- A zoomable map with three more depths behind it: group (repos as nodes), module (files and their imports), symbol (functions, classes, methods, inheritance)
- Dark and light themes (barrel and ground glass), following your system preference
- A dashed ring on any symbol with zero references found in its repo. Treat it as a hint, not a verdict: the matching is name-based and repo-local, so a function consumed from another repo through a package will look unused when it isn't
- Node size scaled by symbol count, so the heavy modules are obvious at a glance
- Filter box, keyboard navigation, reduced-motion support



## Instant, deterministic maps

Older versions ran a physics simulation in your browser, so the map wobbled into place and settled a little differently every time you opened it, like actors finding their marks live on stage. Now the blocking is rehearsed in advance: the same simulation runs once at extract time, headless, and the final positions are baked into the graph files. The viewer opens instantly on a finished picture. No wobble, no waiting, and because the extractor sorts every directory walk, the same repo produces pixel-identical coordinates on any machine, any run. Positions being stable data instead of live physics is also the foundation for diffing maps between commits.

The generated HTML is nearly self-contained too. The d3 library gets vendored into the file at build time, so the map renders on a plane, in an air-gapped environment, anywhere. The only network requests left are the two webfonts, and the viewer falls back to system faces when they don't load.

## Knowing when the map is stale

A map that has drifted from the code is worse than no map, especially when an agent or a script is about to trust its file and line numbers. Every graph now carries a `sourceFingerprint`: a sha256 over the exact files that entered it. Two commands compare that fingerprint against the source tree:

```bash
gitatlas check ~/work/repos                   # exit 0 fresh, exit 1 stale; per-repo status
gitatlas check ~/work/repos --json            # machine-readable report for scripts and agents
gitatlas extract ~/work/repos --if-stale      # re-extract only when something changed
```

`check` re-walks the source with the same discovery rules and hashes file contents, no parsing, no writes. It reports each repo as `fresh`, `stale` (source changed), `new` (no graph yet), `removed` (graph exists, repo gone), or `unknown` (a pre-fingerprint graph). Anything but fresh exits 1.

`extract --if-stale` is the one-liner for CI jobs and agent hooks: run it unconditionally before reading the graphs and it either no-ops in a fraction of the extract time or rebuilds the map. Fingerprints are content-based, not mtime-based, so the same tree is fresh on any machine and any clone. Pass the same `--ignore` and `--submodules` flags you extract with, so the comparison walks the same file set.

## Feeding the map to a coding agent

Two commands turn the map into agent context, and both re-check source fingerprints before emitting anything, so an agent is never handed stale file:line data without a warning inside the output itself.

`brief` compresses the whole map into a token-budgeted markdown digest: per repo, its hubs, neighborhoods, largest modules, and key exports with file and line. Detail sections drop to fit the budget, and every cut is announced in the text, never silent. Paste it into a system prompt, a CLAUDE.md, or a task briefing:

```bash
gitatlas brief                          # reads ./.gitatlas, ~4000 token budget
gitatlas brief --budget 1500            # tighter digest, sections drop to fit
gitatlas brief --repo checkout-api      # one repo only
```

`mcp` serves the map to agents over the Model Context Protocol (stdio), so the agent queries on demand instead of carrying the whole graph in context. Five tools: `brief` (orientation), `scope` (stack trace or symbol to ranked suspects), `find_symbol` (name to file:line across every repo), `module_info` (one file's symbols, imports, and call traffic), and `check_freshness`. Register it with any MCP client, for example in Claude Code:

```bash
claude mcp add gitatlas -- gitatlas mcp --out /path/to/repos/.gitatlas
```

The server is dependency-free like everything else here, reloads automatically when the map is re-extracted, and re-verifies fingerprints (cached for 60 seconds) before every answer. If you extracted with `--ignore` globs, pass the same globs to `brief` and `mcp` so the freshness walk covers the same file set.

## Jump to anything

Press Cmd+K (or Ctrl+K, or tap the ⌘K chip in the title plate). Type a few letters of any repo, file, class, or function across your entire group, hit enter, and the camera flies to it and pulses it red. Hovering any node dims everything except its direct connections, so you can trace one module's wiring through a dense map without losing your place.

## Call edges: who actually phones whom

Imports tell you who knows whom, like an org chart. Call edges are the phone records: which function actually rings which other function. At the symbol level the gold lines are calls, and they change what everything else means. A hub is now a module the rest of the code genuinely leans on at runtime, not just one that appears in many import statements. Neighborhoods cluster on real coupling, because cross-module call traffic feeds the clustering alongside imports. And the bug scoper walks actual call chains out from a crash instead of guessing by file proximity.

One rule governs all of it: ambiguous callees are dropped, never guessed. When helper() could be three different symbols, gitatlas emits no edge rather than a wrong one. Resolution prefers a match in the same file, then accepts a unique match anywhere in the repo, and stays silent otherwise. Every call edge you see is one the extractor would defend.

Call recognition currently covers 14 of the 21 languages: TypeScript, JavaScript, Python, Go, Java, Ruby, C, C++, C#, PHP, Rust, Kotlin, Lua, and Elixir. The rest still get symbols, imports, and inheritance; their call configs are one probed config object away, and CONTRIBUTING shows the shape.

## Neighborhoods and hubs

Open any repo at the module level and you will see shaded regions behind the nodes. Those are neighborhoods, and nobody drew them. Think of a city map: there is no official border around the restaurant district, it exists because those streets connect to each other more than they connect to anywhere else. The clustering does the same thing to your import graph. It groups files that lean on each other heavily and touch the rest of the repo lightly, then labels each group with the deepest folder its members share.

The useful part: neighborhoods are computed from structure, not from your directory tree. When a "utils" file has quietly become load-bearing for the billing code, it shows up inside the billing neighborhood no matter which folder it lives in. The map tells you how the code actually organizes itself, which is not always how it was filed.

Modules with a red outer ring are hubs. Same idea as the busiest intersection in town: count how many roads meet at each node, flag anything far above typical. A hub is where a change ripples widest, which makes it the first place to look before a refactor and the last place to edit casually on a Friday.

Both are deterministic. Same repos in, same neighborhoods and hubs out, every single run. No model calls, no randomness, nothing leaves your machine. Under the hood it is greedy modularity clustering with stable ordering (the Louvain approach, single level) and plain degree statistics. We say that precisely because tools in this space love to borrow fancier algorithm names than they implement.

## Scoping a bug to its neighborhood

When you have a stack trace, you usually don't need the whole repo, you need the few functions around the crash. `scope` resolves a trace into the graph and returns the bounded neighborhood, ranked by structural distance. No LLM, no write path, diagnosis only.

```bash
npm run extract -- fixtures
npm run scope -- --trace crash.txt --out fixtures/.gitatlas
npm run scope -- --symbol charge --out fixtures/.gitatlas --json   # or anchor on a name
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
- watch mode and incremental re-extraction

Already shipped: call edges (0.9.0), precomputed deterministic layout and the command palette (0.8.0), 21 languages (0.7.0), neighborhoods and hubs (0.6.0), the `scope` bug scoper (0.4.0).


## Put it in every repo

The whole tool is one command with no setup, which makes it cheap to adopt as a default:

```bash
npm install -g <this-repo>     # or npx once published
gitatlas extract .             # from any repo root
```

For CI, copy `examples/github-action.yml` into `.github/workflows/gitatlas.yml` and every push to main regenerates the map as a downloadable artifact. Point the upload step at GitHub Pages instead and the architecture map becomes a living URL your team can bookmark. Because the output is one HTML file, there is nothing to host, patch, or keep alive.

If you want it truly everywhere, add the extract step to your repo template or your org's scaffolding tool, the same slot where LICENSE and CI config already get stamped in.

## Hosted playground

`npm run site` starts a small server that maps any public GitHub repo on demand: visit `/gh/owner/repo` (or paste a URL into the landing page) and it shallow-clones the repo, runs the extractor in an isolated child process, and serves the generated map. Maps are cached by commit SHA and rebuilt only when the repo's HEAD moves.

```bash
npm run site                       # http://localhost:8130
# then open http://localhost:8130/gh/expressjs/express
```

This is for public repos and demo deployments. The local CLI remains the real product: the playground necessarily processes submitted code on the server, so never point people at it for private code.

Configuration is environment variables, all optional:

- `PORT` listen port (default 8130; range 1-65535)
- `GITATLAS_SITE_CACHE_DIR` cache location (default `.gitatlas-site`)
- `GITATLAS_SITE_MAX_REPO_MB` stop clone workspaces that grow beyond this (default 200; range 1-10240)
- `GITATLAS_SITE_CACHE_MB` total cache cap, oldest maps evicted first (default 2048; range 1-1048576)
- `GITATLAS_SITE_CONCURRENCY` parallel builds (default 1; range 1-64)
- `GITATLAS_SITE_MAX_ACTIVE_JOBS` combined lookup, running, and queued work cap (default 8; range 1-1024 and never lower than concurrency)
- `GITATLAS_SITE_REQUESTS_PER_MINUTE` global new-map request limit (default 30; range 1-100000)
- `GITATLAS_SITE_CLONE_TIMEOUT_S` / `GITATLAS_SITE_EXTRACT_TIMEOUT_S` build timeouts (defaults 120 / 300; range 1-86400 each)
- `GITATLAS_SITE_HEAD_TTL_S` how long a resolved HEAD SHA is trusted before ls-remote runs again (default 300; range 1-86400)

The server needs `git` on PATH and outbound access to github.com. Nothing else: no database, no API keys, no GitHub token (existence checks and clones go through plain `git ls-remote` / `git clone`, which have no API rate limits).

### Deploying it cheaply

The repo ships three ready-made paths, cheapest first:

- **Render free tier, $0.** `render.yaml` is a one-click Blueprint: in the Render dashboard choose New, then Blueprint, and point it at your fork. The free instance sleeps after about 15 idle minutes (the next visitor waits out a cold start), and its disk is ephemeral, so the map cache rebuilds after restarts. Fine for a public demo. The blueprint lowers the repo cap to 50 MB to stay inside the 512 MB of RAM.
- **Fly.io scale-to-zero, roughly $2 to $3 a month.** `fly.toml` plus the `Dockerfile`: run `fly launch --copy-config`, then `fly deploy`. Machines stop when idle and wake in seconds rather than a minute. Create a small volume and uncomment the `[mounts]` block if you want maps to survive cold starts.
- **A small VPS, roughly $4 a month, or Oracle Cloud's Always Free VM, $0.** Anywhere Node 22 and git exist: `npm ci && npm run site` behind any reverse proxy, or `docker build -t gitatlas-site . && docker run -p 8130:8130 -v gitatlas-cache:/data gitatlas-site`. Always warm, persistent cache, no sleep. Oracle's free ARM VM (4 cores, 24 GB) is the most machine for zero dollars if you don't mind the setup.

Also $0: an always-on machine you already own plus a Cloudflare Tunnel.

Two free-tier notes: extraction is the memory-heavy step, so on 512 MB instances keep `GITATLAS_SITE_MAX_REPO_MB` at 50 or lower; and every build costs real CPU, so tune the active-job and request limits before promoting a playground URL widely.

The `Dockerfile` uses Node 22 (no wasm flag dance), installs git, runs as the unprivileged built-in `node` user, and points the cache at the writable `/data` volume. Named and anonymous volumes work without extra setup; bind mounts must be writable by UID 1000. The cache is a cache: losing it costs a rebuild, never data.

## Prior art

GitNexus and CodeGraph build deep per-repo knowledge graphs for AI agents. Structurizr renders the C4 zoom ladder beautifully but you declare the model by hand. Sourcegraph navigates across repos at enterprise scale. None of them auto-generate a zoomable system-to-symbol map from a folder of repos as one local HTML file. That gap is the reason this exists.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md). The most valuable contribution right now is a new language extractor, and the doc walks through exactly what one has to emit.

## License

MIT
