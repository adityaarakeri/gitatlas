# Security policy

## Supported versions

gitatlas is pre-1.0 and unpublished. Only the latest commit on `main` receives fixes. There are no backports.

## Reporting a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/adityaarakeri/gitatlas/security/advisories/new) for anything exploitable. If that is unavailable, email the maintainer at the address in `package.json` with `SECURITY` in the subject.

Please do not open a public issue for an exploitable bug.

Expect an acknowledgement within a few days. Since this is a small project, a fix timeline depends on severity, and I will tell you honestly if something will take a while.

## What is in scope

gitatlas parses source code you point it at. The threat model that matters most:

- **Parser and extractor.** Crafted source files reaching the TypeScript compiler API or a tree-sitter grammar. Crashes are bugs; anything that escapes the parse into code execution or arbitrary file access is a vulnerability.
- **Path handling.** Repo discovery, `--ignore` globs, submodule resolution, and `--out` writes should never read or write outside the directories you named. Traversal escapes are in scope.
- **The generated viewer.** Symbol names, file paths, and repo names from your code are embedded into `index.html`. Anything that lets that data break out of its context and execute as script is in scope.
- **The hosted playground** (`gitatlas site`) clones and extracts untrusted public repositories in a child process. Sandbox escapes, resource-exhaustion bypasses of the configured caps, and cache-poisoning across repos are in scope.

## What is not in scope

- Running `gitatlas extract` on a repository you do not trust and being surprised that its file names appear in your map. The tool reads what you point it at.
- The playground processing code submitted to it. That is the documented purpose of that server, which is why the README tells you not to point it at private code.
- Missing hardening on a deployment you configured yourself (no reverse proxy, no rate limit, caps raised past the documented defaults).
- Fonts loading from Google Fonts in the generated viewer. This is documented, and the map renders without them.

## Note on dependencies

There are four runtime dependencies, all pure JavaScript or WebAssembly, with no native build step. CI runs `npm audit --omit=dev --audit-level=high` on every push and pull request. If you find a vulnerable transitive dependency, an issue is fine; it is not sensitive.
