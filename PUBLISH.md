# Publishing gitatlas

Plan for shipping gitatlas as a global CLI: an npm package (`npm i -g`, `npx`) and a
Homebrew formula. Nothing here is implemented yet. This file is the spec; each phase
lists the concrete edits, the verification that proves it, and the reason.

Current state: `package.json` is `"private": true`, the `bin` entry executes TypeScript
sources through `tsx` (a devDependency), and there is no build step, no git remote, no
tags, and no `files` allowlist. All four block a working `npm install -g`.

---

## Phase 0: the name (settled)

`gitatlas`, unscoped. Verified unclaimed on npm and with no homebrew-core formula. The
project was renamed from `repolens` before any release (see `RENAME.md`), so the npm
package, the binary on PATH, and the Homebrew formula all share one name and `npx gitatlas`
works with no scope.

Nothing further to decide here. The rest of this plan assumes `gitatlas` throughout.

---

## Phase 1: make the tarball actually run

### 1a. The `tsx` problem

`bin/gitatlas.js` does `require("tsx/cjs")` and then requires `.ts` files directly.
`tsx` is a devDependency, so a published tarball crashes on first run with
`Cannot find module 'tsx/cjs'`. Two ways out.

**Option A: promote `tsx` to a runtime dependency.** One line. But it pulls
platform-specific esbuild binaries (about 12 MB per platform) into every install, ships
TypeScript source as the shipped artifact, and pays a transpile cost on every CLI
invocation.

**Option B (recommended): compile to CommonJS into `dist/`, keep `tsx` for development.**

CommonJS specifically, not ESM. The code is already CJS-shaped because `tsx/cjs` has
always transpiled it that way:

- `packages/extractor/src/cli.ts:229` and `:237` use `__dirname`
- `packages/extractor/src/extract.ts:898` uses `require.resolve("tree-sitter-wasms/package.json")`
- `packages/extractor/src/layout.ts:14` uses `require("d3-force")`
- `packages/site/src/server.ts:58` uses `__dirname`

An ESM emit breaks all four. A CJS emit preserves them byte-for-byte. `import.meta.dirname`
appears only in test files, which are excluded from the build, so nothing blocks the CJS
target. Re-verify with `rg -n "import\.meta" packages --glob "*.ts"` before building; if it
ever appears in `src/`, this decision has to be revisited.

Add `tsconfig.build.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "module": "commonjs",
    "moduleResolution": "node10",
    "allowImportingTsExtensions": false,
    "noEmit": false,
    "declaration": false,
    "outDir": "dist",
    "rootDir": "."
  },
  "include": ["packages/*/src/**/*.ts"],
  "exclude": ["packages/*/test/**", "**/fixtures/**", "**/node_modules/**"]
}
```

`allowImportingTsExtensions` has to go off to emit, and it can: every `src/` file already
imports with `.js` extensions (`import { globToRegExp } from "../../extractor/src/extract.js"`).
Only test files use `.ts` extensions, and they stay out of the build and keep running
through `tsx` from source. Emitted layout mirrors the source tree, so the cross-package
relative paths keep resolving: `dist/packages/extractor/src/cli.js`,
`dist/packages/schema/src/types.js`, and so on.

### 1b. Non-TypeScript assets tsc will not copy

Two runtime paths are computed relative to `__dirname` and land outside `dist/` after the
move. Both must be fixed, not worked around:

1. `packages/extractor/src/cli.ts:229` resolves `__dirname/../../viewer/template.html`.
   From `dist/packages/extractor/src/` that is `dist/packages/viewer/template.html`, which
   tsc does not create. Fix: the build script copies `packages/viewer/template.html` to
   `dist/packages/viewer/template.html`. The existing `fs.existsSync` guard means a missed
   copy degrades to "warning: viewer template not found" instead of failing loudly, so the
   smoke test in Phase 3 must assert `index.html` exists rather than trusting exit code 0.

2. `packages/site/src/server.ts:58` resolves `__dirname/../../../bin/gitatlas.js`. From
   `dist/packages/site/src/` that is `dist/bin/gitatlas.js`, which does not exist, so
   `gitatlas site` would spawn a missing binary. Fix: resolve the package root explicitly
   (walk up to the directory containing `package.json`, or export a shared `pkgRoot()`
   helper) instead of counting `..` segments. Counting segments is what broke; adding one
   more `..` would just move the breakage back to the from-source path.

`packages/viewer/template.html` is the only non-TS runtime asset. The d3 lookup at
`cli.ts:237` walks up from `__dirname` looking for `node_modules/d3/dist/d3.min.js` and
keeps working in a global install because `d3` is a production dependency, but this is
exactly the kind of thing that only fails on a real install, so Phase 3 verifies it by
asserting the generated HTML does not contain a CDN script tag.

Add a `scripts/build.mjs` that runs `tsc -p tsconfig.build.json` and then copies the
template. Wire it as `"build": "node scripts/build.mjs"` and
`"prepack": "npm run build"` so `npm pack` and `npm publish` cannot produce a tarball with
a stale or missing `dist/`.

### 1c. `bin/gitatlas.js` dual dispatch

The entry point should prefer `dist/` and fall back to `tsx` plus sources, so a git clone
keeps working with no build step (the entire developer quick start in the README depends
on that):

```js
const path = require("path");
const fs = require("fs");
const DIST = path.join(__dirname, "..", "dist", "packages");
const useDist = fs.existsSync(DIST);
if (!useDist) require("tsx/cjs");
const ext = useDist ? "js" : "ts";
const base = useDist ? DIST : path.join(__dirname, "..", "packages");
// ... require(path.join(base, "extractor/src/cli." + ext)) etc.
```

The Node 24 `--liftoff-only` re-exec at the top of the file stays exactly as it is. It is
load-bearing for the published package too, and it is the reason CI must keep testing on
both 22 and 24.

### 1d. package.json metadata

```jsonc
{
  "name": "gitatlas",
  "version": "0.10.0",             // Phase 4
  "private": false,                // or delete the key
  "type": "commonjs",              // explicit; dist/ is CJS
  "files": ["bin", "dist", "README.md", "LICENSE", "CHANGELOG.md"],
  "repository": { "type": "git", "url": "git+https://github.com/OWNER/gitatlas.git" },
  "homepage": "https://github.com/OWNER/gitatlas#readme",
  "bugs": { "url": "https://github.com/OWNER/gitatlas/issues" },
  "author": "Aditya Arakeri",
  "publishConfig": { "access": "public", "provenance": true },
  "scripts": {
    "build": "node scripts/build.mjs",
    "prepack": "npm run build"
  }
}
```

The `files` allowlist matters more than usual here: the working tree carries `.agent/`,
`.gitatlas-site/`, `top5.md`, `CHECKLIST.md`, `fly.toml`, and `render.yaml`, and npm packs
the working directory rather than git's index, so untracked files ship unless excluded.
An allowlist is safer than an `.npmignore` denylist because new junk defaults to excluded.

`"workspaces": ["packages/*"]` can stay or go. There are no per-package `package.json`
files, so the field currently does nothing. Leaving it is harmless; removing it is one
less thing to explain.

Deliberately not shipped: `fixtures/` (475 KB, test-only), `examples/`, `blog/`,
`Dockerfile`, `fly.toml`, `render.yaml`. Anyone who wants the fixture smoke test clones
the repo.

Install size will be roughly 60 MB, dominated by `tree-sitter-wasms` (50 MB) and
`web-tree-sitter` (5.7 MB). That is the cost of 21 languages with zero native compilation,
and it is worth calling out in the README next to the install command so it is not a
surprise.

---

## Phase 2: repository and release plumbing

1. Create the GitHub repo and push. There is currently no remote and one commit
   (`7c52d23 gitatlas 0.9.0: initial public commit`). npm provenance requires a public
   repo and a matching `repository` field.
2. Fold the CHANGELOG `Unreleased` block into a `0.10.0` section with a date.
3. Tag `v0.10.0`.

Add `.github/workflows/release.yml`, triggered on `v*` tags. It reuses the existing `ci`
job as a gate, then packs, installs the tarball into a temp prefix, smoke tests the real
binary, and only then publishes:

```yaml
name: release
on:
  push:
    tags: ["v*"]
permissions:
  contents: read
  id-token: write        # required for npm provenance
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          registry-url: https://registry.npmjs.org
      - run: npm ci
      - run: npm run typecheck && npm run lint && npm test
      - run: npm pack
      - name: install the tarball and smoke test the real binary
        run: |
          npm i -g ./*.tgz
          gitatlas extract fixtures --out /tmp/m
          test -f /tmp/m/index.html
          node -e "const h=require('fs').readFileSync('/tmp/m/index.html','utf8');
                   if(h.includes('/*__DATA__*/null')) throw new Error('no data baked in');
                   if(h.includes('cdnjs.cloudflare.com')) throw new Error('d3 not vendored')"
          gitatlas check fixtures --out /tmp/m
          gitatlas brief --out /tmp/m --budget 800 | head -5
          gitatlas scope --symbol charge --out /tmp/m --json > /dev/null
      - run: npm publish
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

Auth: prefer npm trusted publishing (OIDC, no long-lived secret) if the account has it
enabled; otherwise a granular access token scoped to this one package, stored as
`NPM_TOKEN`. `--provenance` comes from `publishConfig` and needs `id-token: write`.

Note the smoke test runs against `fixtures/`, which the tarball does not ship. That is
intentional: the fixtures come from the checkout, the binary comes from the installed
tarball, which is exactly the separation that catches a missing `files` entry.

---

## Phase 3: pre-publish verification

The failure mode this whole plan exists to prevent is "works from the clone, broken from
the tarball". Everything below tests the installed artifact, never the working tree.

- `npm pack --dry-run` and read the file list. Confirm `dist/packages/viewer/template.html`
  is present and `.agent/`, `.gitatlas-site/`, `top5.md`, `CHECKLIST.md`, `fixtures/` are not.
- Global install from the tarball into a scratch prefix, then run all six commands:
  `extract`, `check`, `brief`, `mcp`, `scope`, `site`. Run each from a directory that is
  not the repo, so any surviving `process.cwd()` assumption surfaces.
- Assert the generated `index.html` has data baked in and no CDN script tag (proves the
  template copy and the d3 walk-up both survived the move to `dist/`).
- `npx gitatlas extract .` after publishing, on a clean machine with no clone.
- Matrix: Node 22 and Node 24 (24 exercises the `--liftoff-only` re-exec, which is a wasm
  crash guard, not a nicety), on Windows, macOS, and Linux. tree-sitter grammars are wasm
  so there is no native build to break, but the re-exec spawns a child process and the
  path handling differs on Windows.
- `gitatlas mcp` over stdio against a real MCP client, since it is the one command with no
  human-readable output to eyeball.

---

## Phase 4: version and release notes

Publish `0.10.0`, not `1.0.0`. The `Unreleased` CHANGELOG block is large (brief, mcp,
check, staleness detection, the site playground, the tree landing page, the Node 24 fix),
so a minor bump reflects it honestly, and 1.0.0 should mean "SCHEMA_VERSION is stable and
I will not break it", which is a promise worth making separately and deliberately.

If a public trial run is wanted first: `npm publish --tag next` with `0.10.0-rc.0`,
verify `npm i -g gitatlas@next`, then publish the real thing. Homebrew tracks
only stable versions, so the tap comes after the stable publish either way.

---

## Phase 5: Homebrew

### 5a. Own tap first

homebrew-core has a notability bar (roughly 75 stars / 30 forks / 30 watchers, plus
"more than a thin wrapper around npm install") that a day-one project does not clear. A
personal tap has no bar and works immediately.

Create the repo `OWNER/homebrew-gitatlas` with `Formula/gitatlas.rb`:

```ruby
class Gitatlas < Formula
  desc "Multi-repo architecture maps you can zoom into"
  homepage "https://github.com/OWNER/gitatlas"
  url "https://registry.npmjs.org/gitatlas/-/gitatlas-0.10.0.tgz"
  sha256 "FILL_IN"
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  test do
    (testpath/"repo/.git").mkpath
    (testpath/"repo/src").mkpath
    (testpath/"repo/src/a.ts").write("export function hello() { return 1 }\n")
    system bin/"gitatlas", "extract", testpath, "--out", testpath/"out"
    assert_path_exists testpath/"out/index.html"
    assert_match "gitatlas", shell_output("#{bin}/gitatlas --help")
  end
end
```

Install command: `brew install OWNER/gitatlas/gitatlas`.

Notes on the formula:

- The url is the npm tarball, not a GitHub tarball. That is the standard pattern for
  Node CLIs and it means Homebrew installs the same artifact npm users get, including
  `dist/`, with no build toolchain on the user's machine.
- `std_npm_args` handles the `libexec` prefix and the production-only install.
- `depends_on "node"` is required. Homebrew will not use the user's system Node.
- The `test do` block needs a directory tree that looks like a group of repos, because
  extraction discovers repos by `.git` markers. Verify the empty-`.git` shortcut actually
  satisfies discovery when running `brew test gitatlas`; if it does not, `git init` in the
  test instead.
- `desc` must not start with an article, must not repeat the formula name, and stays under
  80 characters. The line above already satisfies all three.
- Run `brew audit --strict --online gitatlas` and `brew test gitatlas` before pushing.

Practical constraint: Homebrew runs on macOS and Linux only, and this workstation is
Windows. Formula work has to happen on a macOS or Linux machine, or on a
`macos-latest` GitHub Actions runner.

### 5b. Keeping the formula current

`brew bump-formula-pr` targets homebrew-core, so a tap needs its own path. Simplest
reliable version: after `npm publish` succeeds, the release workflow fetches the published
tarball's sha256 from the registry, rewrites `url` and `sha256` in the tap repo, and opens
a PR (or commits directly) using a fine-grained PAT with write access to the tap only.

```bash
# sha256 of a published version, straight from the registry
npm view gitatlas@0.10.0 dist.tarball dist.integrity
```

npm reports `integrity` as base64 sha512; Homebrew wants hex sha256, so download the
tarball and `shasum -a 256` it rather than converting.

### 5c. homebrew-core later

Once the project clears the notability bar, submit the same formula to homebrew-core with
`brew bump-formula-pr` or a manual PR, then deprecate the tap with a README pointer. Core
also requires no `head` spec issues, a passing `brew test-bot`, and a stable versioned url,
all of which the formula above already satisfies.

---

## Phase 6: documentation after the first publish

These are the doc edits that the publish makes true, listed so they are not forgotten:

- `README.md:7`: replace the "not published yet, install from a clone" note with the real
  install commands.
- `README.md` quick start: lead with `npm i -g gitatlas` and
  `brew install OWNER/gitatlas/gitatlas`; keep the clone workflow as the contributor path.
- `README.md:205`: replace `npm install -g <this-repo>   # or npx once published` with the
  real package name and a working `npx` line.
- Mention the roughly 60 MB install size next to the install command.
- The command reference table says "From a clone, `npm run <command> --` invokes the same
  thing". Reword so the global binary is the primary form and npm scripts are the fallback.
- Add npm version and CI badges.
- `CONTRIBUTING.md`: document `npm run build` and the "test the tarball, not the tree" rule.

---

## Ordered checklist

1. ~~Decide the published name.~~ Done: `gitatlas`, see Phase 0.
2. Create the GitHub repo, push `main`, confirm the `repository` field matches.
3. Add `tsconfig.build.json`, `scripts/build.mjs` (tsc plus the template copy), and the
   `build` / `prepack` scripts.
4. Fix the two `__dirname` paths that break under `dist/` (viewer template, site bin).
5. Make `bin/gitatlas.js` prefer `dist/` and fall back to `tsx` plus sources.
6. Update `package.json`: drop `private`, add `files`, repo metadata, `publishConfig`.
7. `npm pack --dry-run`, audit the file list, install the tarball globally, run all six
   commands from outside the repo on Node 22 and 24.
8. CHANGELOG `Unreleased` becomes `0.10.0`; bump `version`; tag `v0.10.0`.
9. Add `release.yml`; configure npm trusted publishing or `NPM_TOKEN`.
10. Push the tag, confirm the publish and the provenance attestation on npmjs.com.
11. Verify `npx gitatlas extract .` on a clean machine.
12. Create `OWNER/homebrew-gitatlas`, add the formula, `brew audit --strict --online` and
    `brew test` on macOS or Linux, push.
13. Wire the tap bump into the release workflow.
14. Do the Phase 6 doc pass.

## Risks

- **The name.** Settled as `gitatlas` and already threaded through the tree. Everything
  downstream (formula url, README, npx examples) hardcodes it, so another change means
  another full pass. Claim the npm name early, even with a placeholder version.
- **Silent viewer degradation.** A missing `template.html` in `dist/` prints a warning and
  exits 0, producing a map with no HTML. Only an artifact-level assertion catches it, which
  is why the smoke test checks the file rather than the exit code.
- **Node 24 wasm crash (nodejs/node#63421).** The `--liftoff-only` re-exec must survive the
  refactor of `bin/gitatlas.js`. Losing it turns into a hard crash during extraction, not a
  clean error. CI already covers Node 24; keep it that way.
- **60 MB install.** Not fixable without dropping languages or fetching grammars lazily at
  runtime, and lazy fetching would break the "no required network" rule. Document it
  instead.
- **Homebrew from Windows.** The formula cannot be developed or tested on this machine.
  Budget for a macOS or Linux environment, or a CI runner.
