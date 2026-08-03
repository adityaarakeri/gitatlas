# Contributing to gitatlas

Thanks for looking under the hood. This doc covers setup, the architecture you're stepping into, and the rules that keep the project coherent.

## Setup

```bash
git clone <this-repo> && cd gitatlas
npm install
npm run extract -- fixtures        # smoke test: should index 3 repos and emit index.html
```

Requirements: Node 22+. No native dependencies, no build step. The extractor runs through `tsx` directly.

Note for Node 24: V8's turboshaft wasm pipeline crashes compiling tree-sitter grammars ([nodejs/node#63421](https://github.com/nodejs/node/issues/63421)). The CLI and npm scripts pass `--liftoff-only` for you; when running a test file by hand, do the same: `node --liftoff-only --import tsx packages/extractor/test/extract.test.ts`.

## Repo layout

```
packages/schema/      the graph schema. The contract. Start here.
packages/extractor/   CLI: repo discovery, TS/JS extraction, viewer generation
packages/viewer/      template.html, a single-file viewer (vanilla JS + d3)
fixtures/             three tiny fake repos used as the smoke test
```

## The three rules

Every change gets measured against these. PRs that violate one need a very good argument.

1. **The schema is the contract.** Extractors emit `RepoGraph` JSON, the viewer consumes it, and neither knows the other exists. Additive schema changes (new optional fields) are fine. Breaking changes require bumping `SCHEMA_VERSION` and a migration note in the PR.
2. **Artifacts are files.** No daemon, no database, no required network. If your feature needs a server, it probably belongs in a different project.
3. **Every edge carries confidence.** `exact` (statically certain), `resolved` (matched within the repo), `inferred` (name-based or heuristic guess). The viewer draws inferred edges dashed. Never upgrade a guess to a fact.

## The highest-value contribution: a language extractor

The TS extractor (`packages/extractor/src/cli.ts`, `extractRepo`) is the reference implementation. A new language extractor must produce the same shape:

```jsonc
{
  "schemaVersion": "0.1.0",
  "repo": "my-service",
  "language": ["python"],
  "modules":  [{ "id": "my-service:src/app.py", "path": "src/app.py", "repo": "my-service", "symbolCount": 4, "loc": 120 }],
  "symbols":  [{ "id": "my-service:src/app.py:handler", "name": "handler", "kind": "function", "module": "my-service:src/app.py", "line": 12, "exported": true, "refCount": 3 }],
  "edges":    [{ "from": "my-service:src/app.py", "to": "my-service:src/db.py", "kind": "imports", "confidence": "resolved" }]
}
```

Ground rules for extractors:

- **The tree-sitter engine already exists** (`packages/extractor/src/extract.ts`, `SITTER_LANGS`). A new language is usually a config object: file extensions, the wasm grammar name (must exist in tree-sitter-wasms), which node types declare functions and classes, how to read a name, what "exported" means in that language, and a resolver that turns an import spec into a repo-relative file path or null. Python, Go, Ruby, and Java are the four worked examples; copy the closest one.
- The runtime is pinned to web-tree-sitter 0.25.x, which spans both grammar ABI generations shipped in tree-sitter-wasms (13 through 15). Do not bump either package alone; bump both and rerun the full suite.
- Two lessons paid for in debugging time, now encoded in the engine: use a fresh parser per file, because a file that mis-parses can poison a reused parser for every file after it. And when a grammar's scanner has bugs against real-world syntax (the lua wasm chokes on dots inside require strings), add a `textImports` regex fallback to the config rather than losing the edges silently.
- The gap detector in polyglot.test.ts iterates SITTER_LANGS. Registering a language without a fixture file in fixtures/polyglot-lab, or with a config that extracts nothing, fails the suite by design.
- ID conventions are load-bearing: modules are `repo:relative/path`, symbols are `repo:relative/path:Name`, methods are `Name.method` with `parent` set to the class symbol id.
- `refCount` is optional. If you implement it, it means "identifier occurrences beyond declarations, repo-local, name-based." Don't implement something stricter and call it the same thing; add a new field instead.
- Don't resolve what you can't resolve. An import you can't map to a file becomes `pkg:<specifier>` with confidence `exact` (the import statement is a fact, its target is not).

## Call edge changes

Call recognition is a per-language config: node types plus a callee reader, next to the existing import config. The resolution pipeline is shared and enforces the honesty rule: same-module match first, unique repo-wide match second, silence otherwise. Do not weaken that rule to boost edge counts; a wrong call edge poisons the scoper, the hubs, and every user's trust at once. Adding call support to a language means probing its call node shape first (see the probe pattern in git history), writing the config, and adding a semantic assertion to the extractor tests.

## Layout changes

Layout is computed at extract time in packages/extractor/src/layout.ts and must stay deterministic: sorted node input, no wall-clock, no Math.random. The extract test suite asserts coordinate equality across runs; if your change breaks that test, the change is wrong, not the test. The viewer never simulates; it draws the coordinates it is given, with a grid fallback for graphs generated before layout existed.

## Analysis changes

Everything in `packages/analysis` must be deterministic: sorted iteration, explicit tie-breaking, no randomness, no wall-clock dependence. The determinism test (same graph, shuffled input order, identical output) is the gate. If your algorithm needs a seed, it does not belong here.

## Viewer changes

The viewer is one template file with vanilla JS. That's deliberate: no framework, no build, view-source-able. Keep it that way.

- All colors flow through CSS variables. Both themes (`data-theme="dark"` and `"light"`) must be updated together.
- Visible focus states and `prefers-reduced-motion` support are non-negotiable. Test keyboard navigation (Tab to a node, Enter to open it).
- Test on a phone viewport. The bottom bar layout exists because overlap bugs are easy to ship from a desktop browser.
- UI copy is plain and active. "Tap a node to open it," not "Nodes can be interacted with."

## Testing

The extractor and scoper both have unit suites (Node's built-in runner, no deps):

```bash
npm test                 # full suite: extractor (incl. all 21 languages), analysis, scoper
```

Logic that can be pure should be pure and tested. The scoper is split exactly that way: `scope.ts` is all pure functions (trace parsing, resolution, walking, ranking) with `cli.ts` doing only I/O. Mirror that split for new logic so it stays testable.

The extractor and viewer still rely on the smoke test:

```bash
npm run extract -- fixtures
# verify: 3 repos discovered, index.html generated, opens, descends and ascends cleanly
```

Fixture-based snapshot tests for extractor graph output are a welcome PR.

### The published package

Development runs the TypeScript sources through tsx; the npm tarball ships compiled CommonJS in `dist/` (built by `npm run build`, wired into `prepack` so a stale `dist/` cannot be published). `bin/gitatlas.js` prefers `dist/` when it exists and falls back to sources, so a clone never needs a build step, but that also means the clone does not exercise the shipped artifact. For anything touching packaging, paths, or `__dirname` logic, test the tarball, not the tree:

```bash
npm pack
npm install -g --prefix /tmp/gitatlas-test ./gitatlas-*.tgz
# run extract/check/brief/scope from a directory outside the repo,
# then assert the generated index.html exists with data baked in
```

### Dependency security

CI runs `npm run audit:prod` and blocks high or critical vulnerabilities in production dependencies. Run the same command before submitting dependency changes.

If the gate fails, use `npm audit --omit=dev` to identify the advisory and `npm explain <package>` to find the direct dependency that introduced it. Update that direct dependency, commit both `package.json` and `package-lock.json`, then run `npm run audit:prod`, `npm run typecheck`, `npm run lint`, and `npm test`. Do not use `npm audit fix --force`; major-version remediation needs an explicit compatibility review.

## Pull requests

- One concern per PR. An extractor and a viewer feature are two PRs.
- Describe what you ran, not just what you wrote.
- Schema changes: state whether additive or breaking, and bump `SCHEMA_VERSION` for breaking.
- New CLI flags need a line in the README and a sane default that preserves current behavior.
- Style: no em dashes in docs or UI copy. Use commas, periods, or restructure.

## Reporting bugs

Include the command you ran, your folder structure (depth, submodules, monorepo or not), Node version, and the console output. Discovery bugs are almost always structure-dependent, so the structure matters more than the stack trace. The [bug report form](.github/ISSUE_TEMPLATE/bug_report.yml) asks for exactly this.

For anything exploitable, report privately instead. See [SECURITY.md](SECURITY.md).

## Code of conduct

Be direct about code, decent to people. Maintainers will close anything that confuses the two. The full policy is in [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
