# CLI reference

One binary, six commands. From a clone, `npm run <command> --` invokes the same thing (for example `npm run extract -- fixtures`).

| Command | What it does |
| --- | --- |
| `gitatlas extract <folder\|github-repo>` | Build the map: one graph JSON per repo plus the self-contained viewer HTML |
| `gitatlas check <folder\|github-repo>` | Compare source fingerprints against the existing map. Exit 0 fresh, 1 stale |
| `gitatlas brief` | Token-budgeted markdown digest of the map for agent context |
| `gitatlas mcp` | Serve the map to AI agents over MCP on stdio |
| `gitatlas scope` | Rank the structural neighborhood around a bug signal |
| `gitatlas site` | Start the hosted playground that maps public GitHub repos on demand |

`extract` and `check` default `--out` to `<folder>/.gitatlas`. `brief`, `mcp`, and `scope` default it to `./.gitatlas` in the current directory, or take `--target <folder|github-repo>` to read the map for whatever you extracted.

## Flags

### `extract <folder|github-repo>`

| Flag | Effect |
| --- | --- |
| `--out <dir>` | Where graphs and `index.html` are written (default `<folder>/.gitatlas`) |
| `--ref <branch\|tag\|commit>` | Which commit of a GitHub target to map (default: the default branch) |
| `--ignore <glob>` | Skip matching paths. Repeatable |
| `--submodules split\|absorb\|skip` | How git submodules are treated (default `split`) |
| `--depth N` | Hard cap on discovery depth |
| `--max-scan N` | Scanned-directory budget (default 25000) |
| `--if-stale` | Skip the whole run when no source content changed |
| `--cache-dir <dir>` | Where GitHub targets are cloned (default `~/.gitatlas`, or `GITATLAS_CACHE_DIR`) |

### `check <folder|github-repo>`

| Flag | Effect |
| --- | --- |
| `--out <dir>` | Map to compare against |
| `--ref <branch\|tag\|commit>` | Must match what you extracted with |
| `--ignore <glob>` | Must match what you extracted with |
| `--json` | Machine-readable report |
| `--cache-dir <dir>` | Where GitHub targets are cloned (default `~/.gitatlas`, or `GITATLAS_CACHE_DIR`) |

### `brief`

| Flag | Effect |
| --- | --- |
| `--out <dir>` | Map to read |
| `--target <folder\|github-repo>` | Read the map for what you extracted, instead of naming the directory |
| `--ref <branch\|tag\|commit>` | With `--target`, the ref you extracted |
| `--repo <name>` | Restrict to one repo |
| `--budget <tokens>` | Token budget (default ~4000) |
| `--ignore <glob>` | Must match what you extracted with |
| `--cache-dir <dir>` | Where a `--target` GitHub repo was cloned (default `~/.gitatlas`) |

### `mcp`

| Flag | Effect |
| --- | --- |
| `--out <dir>` | Map to serve |
| `--target <folder\|github-repo>` | Serve the map for what you extracted |
| `--ref <branch\|tag\|commit>` | With `--target`, the ref you extracted |
| `--ignore <glob>` | Must match what you extracted with |
| `--cache-dir <dir>` | Where a `--target` GitHub repo was cloned (default `~/.gitatlas`) |

### `scope`

| Flag | Effect |
| --- | --- |
| `--trace <file>` | Anchor on a stack trace |
| `--symbol <name>` | Anchor on a symbol name instead |
| `--out <dir>` | Map to read |
| `--target <folder\|github-repo>` | Read the map for what you extracted |
| `--ref <branch\|tag\|commit>` | With `--target`, the ref you extracted |
| `--repo <name>` | Restrict to one repo |
| `--hops N` | How far to walk from the anchor |
| `--top K` | How many suspects to return |
| `--json` | Machine-readable output |
| `--cache-dir <dir>` | Where a `--target` GitHub repo was cloned (default `~/.gitatlas`) |

See [docs/agents.md](agents.md) for `brief` and `mcp` in depth.

## Pointing it at real structures

The extractor figures out your layout on its own:

```bash
npm run extract -- ~/work/repos              # flat folder of repos
npm run extract -- ~/work/org                # nested: org/team-a/repo-x found at any depth
npm run extract -- ~/work/repos/one-repo     # a single repo works too
```

## Mapping a GitHub repo

`extract` and `check` also take a GitHub repo, in whatever spelling you have on the clipboard:

```bash
gitatlas extract expressjs/express
gitatlas extract https://github.com/expressjs/express
gitatlas extract github.com/expressjs/express/tree/master/lib   # deeper paths are trimmed
gitatlas extract git@github.com:expressjs/express.git
```

The repo is shallow-cloned to `~/.gitatlas/repos/<owner>/<repo>` and the map lands in that clone's `.gitatlas`, so the printed `index.html` path is the one to open. Later runs fetch into the same clone instead of downloading it again, which is what keeps `check` and `--if-stale` meaningful against a moving upstream. Move the cache with `--cache-dir` or `GITATLAS_CACHE_DIR`, and use `--out` to put the map somewhere of your own.

Without a ref the default branch head is what gets checked out, and the commit it landed on is printed every run. Deeper URL paths select nothing: `/tree/master/lib` maps the whole repo, not `lib`.

## Pinning a branch, tag, or commit

```bash
gitatlas extract expressjs/express --ref v4.18.2          # a tag
gitatlas extract expressjs/express --ref 5.0              # a branch
gitatlas extract expressjs/express --ref 97f38e8836f8     # a commit
gitatlas extract https://github.com/expressjs/express/tree/v4.18.2   # the URL carries it
```

A `/tree/<ref>/...` or `/blob/<ref>/...` URL is read as naming that ref, so pasting from the browser maps what you were looking at. `--ref` wins if you pass both, and the disagreement is printed rather than absorbed.

Each ref gets its own clone at `<repo>@<ref>`, and that is the name its map carries (`express@v4.18.2`), so a branch map is never mistaken for the default branch's and mapping one never disturbs the other. Refs that need rewriting for a directory name (`release/4.x`) carry a short hash of the original, so two refs can never share one clone.

Only the first segment after `tree`/`blob` is read as a ref, since `/tree/release/4.x/src` is ambiguous between a slashed branch name and a directory below it. Pass those with `--ref`. Refs are checked before git sees them: anything starting with `-`, or carrying whitespace, `..`, or git's revision characters, is refused rather than handed to git as an argument.

Pass the same `--ref` to `check` and to `brief`, `mcp`, and `scope` (alongside `--target`), so every command means the same map. `--ref` with a folder is an error, not a silent no-op.

A path that exists on disk always wins, so `gitatlas extract owner/repo` reaches for GitHub only when there is no such folder, and says so when it does. Credential prompts are disabled, so a private repo works when your git can already read it non-interactively (credential helper or ssh agent) and fails fast otherwise.

`check` takes the same targets. Against a GitHub repo it fetches first, since comparing your map to a moving upstream means knowing where upstream is now. That fetch is the one write `check` makes, and it touches the clone cache, never the map.

The clone is shallow and does not carry submodules, so a GitHub target with submodules reports them as uninitialized and skips them (`--submodules split` is the default). Run `git submodule update --init` inside the printed clone directory and extract again to pull them in, or use `--submodules skip` to silence the notice.

The read-only commands take the same target instead of a directory path, which saves pasting the cache location:

```bash
gitatlas extract expressjs/express
gitatlas brief --target expressjs/express
gitatlas scope --trace crash.txt --target expressjs/express
gitatlas mcp --target expressjs/express

gitatlas extract expressjs/express --ref v4.18.2         # and the same, pinned
gitatlas brief --target expressjs/express --ref v4.18.2
```

`--target` is path arithmetic only. It never clones or fetches, because a map that was never extracted cannot be read; if nothing is there yet, the command says so and names the directory it looked in.

Discovery scans for `.git` markers with no depth limit, stopping inside each repo it finds. The brake is a scanned-directory budget (25,000 by default) so pointing it at your home directory by accident will not run away. Raise it with `--max-scan 100000`, or cap depth explicitly with `--depth 3` if you want the old-fashioned limit.

## Git submodules

```bash
npm run extract -- ~/work/repos                       # split: each submodule is its own node (default)
npm run extract -- ~/work/repos --submodules absorb   # submodule code counts as part of the parent
npm run extract -- ~/work/repos --submodules skip     # ignore submodule paths entirely
```

Split mode dedupes a submodule vendored into multiple parents and warns about uninitialized ones instead of silently showing hollow nodes.

## Ignoring files

Build artifacts are pruned so the map shows code, not clutter. `node_modules`, `dist`, `build`, `target`, `vendor`, `__pycache__`, every dot-directory, and package-metadata folders like `mypkg.egg-info` and `foo-1.0.dist-info` are skipped automatically.

Add project-specific globs with `--ignore`, repeatable, matched against each entry's name and its repo-relative path:

```bash
npm run extract -- ~/work/repos --ignore '*.min.js' --ignore 'docs/**'
```

Glob semantics: `*` and `?` stop at path separators, `**` crosses them, and a trailing `/**` (as in `docs/**`) also matches the directory itself.

## Scoping a bug to its neighborhood

When you have a stack trace, you usually do not need the whole repo, you need the few functions around the crash. `scope` resolves a trace into the graph and returns the bounded neighborhood, ranked by structural distance. No LLM, no write path, diagnosis only.

```bash
npm run extract -- fixtures
npm run scope -- --trace crash.txt --out fixtures/.gitatlas
npm run scope -- --symbol charge --out fixtures/.gitatlas --json   # or anchor on a name
```

It prints the anchor, the ranked suspects with file:line, and a caveat it means every time: this ranks by how *close* code sits to the symptom, not by how likely it is to be the cause. Bugs where bad data flows through correct-looking code will sit outside the set. It scopes context for you or an agent to reason over. It does not claim to have found the bug.
