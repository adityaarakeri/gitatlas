# Feeding the map to a coding agent

Two commands turn the map into agent context, and both re-check source fingerprints before emitting anything, so an agent is never handed stale file:line data without a warning inside the output itself.

## `brief`: the map as a system prompt

`brief` compresses the whole map into a token-budgeted markdown digest: per repo, its hubs, neighborhoods, largest modules, and key exports with file and line. Detail sections drop to fit the budget, and every cut is announced in the text, never silent. Paste it into a system prompt, a CLAUDE.md, or a task briefing:

```bash
gitatlas brief                          # reads ./.gitatlas, ~4000 token budget
gitatlas brief --budget 1500            # tighter digest, sections drop to fit
gitatlas brief --repo checkout-api      # one repo only
gitatlas brief --target expressjs/express   # the map for a GitHub repo you extracted
```

`--target` takes whatever you gave `extract`, a folder or a GitHub repo, and reads the map that command wrote. Add `--ref <branch|tag|commit>` if you pinned one, since each ref has its own map. `--target` never clones or fetches: if no map is there yet, it says so and names the directory it looked in. `--out` still points at a map directory directly and wins when both are given. `brief`, `mcp`, and `scope` all take these flags.

Pinning a ref is the reliable way to give an agent a map that cannot move under it: a tag fingerprints identically forever, so `check` stays fresh and the digest keeps matching the code the agent is reading.

## `mcp`: the map as a live tool

`mcp` serves the map to agents over the Model Context Protocol (stdio), so the agent queries on demand instead of carrying the whole graph in context. Register it with any MCP client, for example in Claude Code:

```bash
claude mcp add gitatlas -- gitatlas mcp --out /path/to/repos/.gitatlas
claude mcp add gitatlas -- gitatlas mcp --target expressjs/express   # a GitHub repo you extracted
```

Five tools:

| Tool | What it answers |
| --- | --- |
| `brief` | Orientation: what is here, what matters |
| `scope` | Stack trace or symbol to ranked suspects |
| `find_symbol` | Name to file:line across every repo |
| `module_info` | One file's symbols, imports, and call traffic |
| `check_freshness` | Is the map still true for this source tree |

The server is dependency-free like everything else here, reloads automatically when the map is re-extracted, and re-verifies fingerprints (cached for 60 seconds) before every answer.

If you extracted with `--ignore` globs, pass the same globs to `brief` and `mcp` so the freshness walk covers the same file set.

## Knowing when the map is stale

A map that has drifted from the code is worse than no map, especially when an agent or a script is about to trust its file and line numbers. Every graph carries a `sourceFingerprint`: a sha256 over the exact files that entered it. Two commands compare that fingerprint against the source tree:

```bash
gitatlas check ~/work/repos                   # exit 0 fresh, exit 1 stale; per-repo status
gitatlas check ~/work/repos --json            # machine-readable report for scripts and agents
gitatlas extract ~/work/repos --if-stale      # re-extract only when something changed
```

`check` re-walks the source with the same discovery rules and hashes file contents, no parsing, and no writes to the map. (Given a GitHub repo rather than a folder it does write one thing: the fetch that brings the cached clone up to date, which is the only way to know whether upstream moved.) It reports each repo as `fresh`, `stale` (source changed), `new` (no graph yet), `removed` (graph exists, repo gone), or `unknown` (a pre-fingerprint graph). Anything but fresh exits 1.

`extract --if-stale` is the one-liner for CI jobs and agent hooks: run it unconditionally before reading the graphs and it either no-ops in a fraction of the extract time or rebuilds the map. Fingerprints are content-based, not mtime-based, so the same tree is fresh on any machine and any clone. Pass the same `--ignore` and `--submodules` flags you extract with, so the comparison walks the same file set.
