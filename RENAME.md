# Renaming repolens to gitatlas

Plan for changing the product name everywhere. Nothing here is implemented yet.

Scope: 255 occurrences across 41 files in the working tree, excluding `node_modules`,
`.git`, and two throwaway directories handled separately. 16 of those files are tracked
by git; the rest are recent untracked work (`packages/site`, `packages/brief`,
`packages/mcp`, `Dockerfile`, `fly.toml`, `render.yaml`, `tsconfig.json`,
`eslint.config.mjs`, `PUBLISH.md`).

Target name confirmed available: `gitatlas` is unclaimed on npm and has no homebrew-core
formula.

---

## The one fact that makes this easy

Nothing has ever shipped. No npm package, no git remote, no tags, one commit
(`7c52d23 repolens 0.9.0: initial public commit`). There are no installs to migrate, no
CI pipelines in other people's repos calling `repolens extract`, and no `.repolens`
directories on anyone else's disk.

So this is a **hard cut**: no aliases, no deprecation warnings, no dual-read fallbacks,
no legacy env var support. Every compatibility shim you would normally owe users here has
exactly zero users. Adding one would be permanent complexity bought for nobody.

The single exception is your own machine, where `fixtures/.repolens/` and
`.repolens-site/maps/` exist as generated caches. Both are regenerable in seconds. Delete
them rather than migrating them.

---

## Inventory: what the string actually is

Not all 255 hits are the same kind of thing. Grouped by what breaks if you get it wrong:

| Category | Where | Count | Mechanical? |
| --- | --- | --- | --- |
| Prose and docs | `README.md`, `CONTRIBUTING.md`, `CLAUDE.md`, `CHANGELOG.md`, `PUBLISH.md` | ~95 | Yes |
| The `bin/repolens.js` filename | file itself plus 8 referencing files | 36 | No, needs `git mv` |
| Output dir `.repolens` | 4 CLI defaults, `.gitignore`, `tsconfig.json`, `eslint.config.mjs`, `.dockerignore`, CI, docs | 25 | No, see decision 1 |
| Cache dir `.repolens-site` | `service.ts:105`, `.dockerignore`, docs | 17 | Yes |
| Viewer global `window.REPOLENS_DATA` | `packages/viewer/template.html` (3 lines) | 14 | Yes, see decision 3 |
| Env vars `REPOLENS_SITE_*` (10 distinct) | `service.ts`, `Dockerfile`, `fly.toml`, `render.yaml`, `README`, site tests | ~45 | Yes, see decision 2 |
| Deploy identifiers | `repolens-playground`, `repolens-site`, `repolens-cache`, `repolens_cache`, `repolens-site-ci` | ~12 | Yes |
| Test temp-dir prefixes | `repolens-test-`, `repolens-mcp-`, `repolens-http-`, 12 more | ~15 | Yes, internal only |
| MCP `serverInfo.name` | `packages/mcp/src/cli.ts:92` | 1 | Yes, but protocol-visible |
| Package identity | `package.json`, `package-lock.json` | 12 | No, regenerate the lock |
| Copyright line | `LICENSE:3` | 1 | No, see decision 4 |
| Generated cache artifacts | `.repolens-site/maps/**` | ~35 | Delete, do not edit |
| Agent scratch | `.agent/**`, `CHECKLIST.md`, `top5.md` | ~12 | Untracked, see decision 5 |

---

## Decisions that are not search-and-replace

### 1. What replaces the `.repolens` output directory

This is the most user-visible string in the product. It is the default `--out` for all
four commands (`extractor/src/cli.ts:41`, `brief/src/cli.ts:44`, `mcp/src/cli.ts:44`,
`scoper/src/cli.ts:37`) and it appears in every doc example.

Recommendation: **`.gitatlas`**. Matches the product name, stays a dot-dir, and reads
correctly next to `.git` in a listing.

Two hazards I checked, both clear:

- It will not be mistaken for a repo. Discovery tests `fs.existsSync(path.join(dir, ".git"))`
  with an exact name (`extractor/src/cli.ts:57`, `:71`, `:108`), so a `.gitatlas` sibling
  is never read as a git marker.
- It will not index itself. `shouldSkipDir` (`extract.ts:36`) skips every name starting
  with `.`, so the output directory is invisible to a subsequent walk regardless of what
  it is called.

The one residual risk is third-party tooling that globs `.git*` rather than matching `.git`
exactly: some `rsync --exclude` lines, hand-written `.dockerignore` and `.gitignore`
patterns, a few archive scripts. Such a pattern would sweep away generated maps silently.

If that bothers you, the alternative is **`.atlas`**, which is shorter and dodges the
prefix entirely. Its cost is a weaker link to the command name and a possible mental
collision with ariga/atlas (which uses `atlas.hcl`, not `.atlas/`, so no real file
conflict). Either works. Pick one now, because it is baked into docs, CI, `.gitignore`,
`tsconfig.json`, `eslint.config.mjs`, `.dockerignore`, and the example GitHub Action.

### 2. The ten `REPOLENS_SITE_*` environment variables

`REPOLENS_SITE_CACHE_DIR`, `_MAX_REPO_MB`, `_CACHE_MB`, `_CONCURRENCY`, `_MAX_ACTIVE_JOBS`,
`_REQUESTS_PER_MINUTE`, `_CLONE_TIMEOUT_S`, `_EXTRACT_TIMEOUT_S`, `_HEAD_TTL_S`, plus the
`env` reads in `packages/site/src/service.ts:102-118`.

Rename all ten to `GITATLAS_SITE_*`. Hard cut, no dual-read. They are consumed in exactly
one function (`parseSiteConfig`) and set in four places (`Dockerfile:20`, `fly.toml:13`,
`render.yaml:19`, `README.md:227`), and the playground has never been deployed anywhere
that would have them set.

The catch: if you have already deployed to Fly or Render from this working tree, the
running service keeps reading the old names and silently falls back to defaults the moment
you deploy renamed code. Verify with `fly config env` / the Render dashboard before
deploying, or just tear the environment down and redeploy fresh.

### 3. `window.REPOLENS_DATA`

Three lines in `packages/viewer/template.html` (`:354` declares it, `:358` reads it, plus
the title on `:6`). Rename to `window.GITATLAS_DATA`.

Safe because the extractor injects data by replacing the `/*__DATA__*/null` sentinel
(`extractor/src/cli.ts:243`), not by matching the variable name, so the template and the
injector cannot drift apart here.

What does break: the six already-generated maps under `.repolens-site/maps/**` still
carry the old global and the old title. They are a commit-SHA-keyed cache, not data.
Delete the whole directory and let it rebuild.

### 4. The LICENSE copyright line

`LICENSE:3` reads `Copyright (c) 2026 repolens contributors`. Change to
`gitatlas contributors`.

Normally rewriting a copyright attribution deserves care. Here the project has one commit,
one author, no external contributors, and no distribution, so there is no third party whose
attribution you would be altering. Do it in the same commit as everything else.

### 5. What to leave alone

- **`CHANGELOG.md`.** Two options. Since nothing was published under the old name, I
  recommend rewriting the six mentions so the file reads coherently to a new user, and
  adding one line to the `Unreleased` section recording the rename. The alternative
  (freeze history verbatim) buys accuracy nobody can verify against a released artifact.
- **`.agent/**`, `CHECKLIST.md`, `top5.md`.** Untracked agent scratch and audit notes.
  Leave them or delete them, but do not spend review effort on them, and make sure the
  `files` allowlist from `PUBLISH.md` keeps them out of the tarball either way.
- **`package-lock.json`.** Do not hand-edit the three `repolens` strings. Change
  `package.json`, then run `npm install` and commit the regenerated lock.
- **`.repolens-site/`.** Delete. Regenerated cache.

---

## Files to rename, not edit

- `bin/repolens.js` -> `bin/gitatlas.js` via `git mv`. Referenced by `package.json`
  (`bin` map and `scripts`), `eslint.config.mjs:21` and `:69`, `Dockerfile:27`,
  `packages/site/src/server.ts:58`, `packages/mcp/test/mcp.test.ts:15`,
  `packages/extractor/test/cli.test.ts:10`, and prose in `extract.ts:877`.
  Note that `server.ts:58` is already flagged in `PUBLISH.md` Phase 1b as needing a
  package-root resolver instead of counted `..` segments. Fix it during the rename rather
  than twice.
- `examples/github-action.yml` keeps its filename, but its header comment says "drop this
  in at `.github/workflows/repolens.yml`" (`:1`) and the workflow is `name: repolens map`
  (`:4`).
- The project directory `C:\Users\adity\projects\repolens` and the future GitHub repo
  name. Last step, see below.

---

## Execution order

Do it as one atomic commit. A half-renamed tree has broken CI, broken imports, and a
confusing diff, and there is no reason to stage it.

1. **Clean the caches first**, so they cannot pollute the search or the diff:
   `Remove-Item -Recurse -Force .repolens-site, fixtures\.repolens`
2. **Rename the binary**: `git mv bin/repolens.js bin/gitatlas.js`
3. **Bulk replace in this order**, most specific first, so no pattern eats another:
   - `.repolens-site` -> `.gitatlas-site`
   - `REPOLENS_SITE_` -> `GITATLAS_SITE_`
   - `REPOLENS_DATA` -> `GITATLAS_DATA`
   - `.repolens` -> `.gitatlas` (now unambiguous, the `-site` form is already gone)
   - `repolens.js` -> `gitatlas.js`
   - `repolens` -> `gitatlas`
   - `RepoLens` -> `GitAtlas`, `Repolens` -> `Gitatlas` (one occurrence each)
4. **Fix what bulk replace gets wrong**: reread `LICENSE`, `CHANGELOG.md`, `package.json`,
   and `PUBLISH.md` by hand. `PUBLISH.md` needs more than a string swap, see below.
5. **Regenerate the lock**: `npm install`, commit `package-lock.json`.
6. **Rebuild the fixture map**: `npm run extract -- fixtures`, confirm it lands in
   `fixtures/.gitatlas/`.

A `sed`-style bulk pass over the tree must exclude `node_modules`, `.git`, and any file
matched by `.gitignore`. Restrict it to tracked files plus the known untracked source
files rather than running it over the whole directory.

---

## Verification

- `rg -i repolens --hidden --glob '!node_modules' --glob '!.git/*'` returns **zero**
  matches. Anything left is a bug, with no allowed exceptions once the caches are deleted.
- `npm test` (78 tests). The site and MCP suites assert on temp-dir prefixes and env var
  names, so they are the real check that step 3 was complete.
- `npm run typecheck` and `npm run lint`. Lint matters specifically because
  `eslint.config.mjs` names `bin/repolens.js` in two overrides (`:21`, `:69`); if those are
  missed, the CJS rules stop applying to the entry point and lint may still pass while
  silently covering nothing.
- `npm run extract -- fixtures` then confirm `fixtures/.gitatlas/index.html` exists,
  contains baked data, and contains `window.GITATLAS_DATA`.
- `npm run check -- fixtures` exits 0.
- `npm run brief`, `npm run scope`, `npm run mcp` against the new output dir.
- `docker build -t gitatlas-site .` then the container smoke steps from
  `.github/workflows/ci.yml:42-70`, which hardcode `repolens-site:ci`,
  `repolens-site-ci`, and `repolens-site-ci-cache`.
- Grep the generated HTML for the old title: `rg -i repolens fixtures/.gitatlas/index.html`
  must be empty, which proves the template rename took effect in the artifact and not just
  the source.

---

## PUBLISH.md deltas

The rename simplifies the publish plan, so update it in the same commit rather than
letting it describe a dead decision:

- Phase 0 collapses. The name is `gitatlas`, unscoped, verified free on npm and in
  homebrew-core. Delete the three-option table, delete the npm dispute track, delete the
  scoped `@arakeri/repolens` recommendation.
- Package name is `gitatlas`, so the binary, the npm package, and the brew formula all
  share one name and `npx gitatlas` works with no scope.
- Phase 5 tap becomes `OWNER/homebrew-gitatlas`, installed as
  `brew install OWNER/gitatlas/gitatlas`, formula class `Gitatlas`, url
  `https://registry.npmjs.org/gitatlas/-/gitatlas-0.10.0.tgz`.
- Phase 5 formula `desc` must not repeat the formula name, so
  `"Multi-repo architecture maps you can zoom into"` still passes `brew audit`.
- Phase 6 loses the "delete the name-is-taken note" item, because `README.md:7` gets
  deleted outright during the rename instead.
- Phase 1b `bin` path fix and this rename touch the same line
  (`packages/site/src/server.ts:58`). Do it once, here.

---

## Last: the directory and the repo

Do this after the commit lands and the suite is green.

1. Rename `C:\Users\adity\projects\repolens` to `C:\Users\adity\projects\gitatlas`.
2. Create the GitHub repo as `gitatlas` (this is the Phase 2 item from `PUBLISH.md`, and
   there is no remote yet, so there is nothing to rename on the GitHub side).

Two consequences worth knowing before step 1:

- The current shell session's working directory becomes invalid. Close and reopen from the
  new path.
- Claude Code keys its project state and memory to the absolute path, so
  `C--Users-adity-projects-repolens` state does not follow the directory. Expect a fresh
  project context after the move.

---

## Risks

- **Partial replacement.** The failure mode is a green test run with a stale string in a
  path or env var that only production hits. The zero-match grep is the gate, not the test
  suite.
- **Ordering in step 3.** Replacing `repolens` before `.repolens-site` produces
  `.gitatlas-site` correctly but replacing `.repolens` before `.repolens-site` produces
  `.gitatlas-site` from one and `.gitatlassite`-style damage from careless patterns. Follow
  the given order.
- **Regenerated lock file.** `npm install` after a package rename can pick up newer
  transitive versions. Check the lock diff is limited to the name fields plus expected
  churn, and rerun the suite if it is not.
- **A live deployment.** If the playground is running anywhere with `REPOLENS_SITE_*` set,
  renamed code silently falls back to defaults. Check before deploying.
