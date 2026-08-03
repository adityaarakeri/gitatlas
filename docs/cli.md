# CLI reference

One binary, six commands. From a clone, `npm run <command> --` invokes the same thing (for example `npm run extract -- fixtures`).

| Command | What it does |
| --- | --- |
| `gitatlas extract <folder>` | Build the map: one graph JSON per repo plus the self-contained viewer HTML |
| `gitatlas check <folder>` | Compare source fingerprints against the existing map. Exit 0 fresh, 1 stale |
| `gitatlas brief` | Token-budgeted markdown digest of the map for agent context |
| `gitatlas mcp` | Serve the map to AI agents over MCP on stdio |
| `gitatlas scope` | Rank the structural neighborhood around a bug signal |
| `gitatlas site` | Start the hosted playground that maps public GitHub repos on demand |

`extract` and `check` default `--out` to `<folder>/.gitatlas`. `brief`, `mcp`, and `scope` default it to `./.gitatlas` in the current directory.

## Flags

### `extract <folder>`

| Flag | Effect |
| --- | --- |
| `--out <dir>` | Where graphs and `index.html` are written (default `<folder>/.gitatlas`) |
| `--ignore <glob>` | Skip matching paths. Repeatable |
| `--submodules split\|absorb\|skip` | How git submodules are treated (default `split`) |
| `--depth N` | Hard cap on discovery depth |
| `--max-scan N` | Scanned-directory budget (default 25000) |
| `--if-stale` | Skip the whole run when no source content changed |

### `check <folder>`

| Flag | Effect |
| --- | --- |
| `--out <dir>` | Map to compare against |
| `--ignore <glob>` | Must match what you extracted with |
| `--json` | Machine-readable report |

### `brief`

| Flag | Effect |
| --- | --- |
| `--out <dir>` | Map to read |
| `--repo <name>` | Restrict to one repo |
| `--budget <tokens>` | Token budget (default ~4000) |
| `--ignore <glob>` | Must match what you extracted with |

### `mcp`

| Flag | Effect |
| --- | --- |
| `--out <dir>` | Map to serve |
| `--ignore <glob>` | Must match what you extracted with |

### `scope`

| Flag | Effect |
| --- | --- |
| `--trace <file>` | Anchor on a stack trace |
| `--symbol <name>` | Anchor on a symbol name instead |
| `--out <dir>` | Map to read |
| `--repo <name>` | Restrict to one repo |
| `--hops N` | How far to walk from the anchor |
| `--top K` | How many suspects to return |
| `--json` | Machine-readable output |

See [docs/agents.md](agents.md) for `brief` and `mcp` in depth.

## Pointing it at real structures

The extractor figures out your layout on its own:

```bash
npm run extract -- ~/work/repos              # flat folder of repos
npm run extract -- ~/work/org                # nested: org/team-a/repo-x found at any depth
npm run extract -- ~/work/repos/one-repo     # a single repo works too
```

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
