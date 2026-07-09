#!/usr/bin/env node
// Global entry: `repolens extract .` and `repolens scope --trace crash.txt`
// work from anywhere after npm install -g (or via npx once published).

// Node 24's turboshaft wasm pipeline fatally crashes while compiling
// tree-sitter grammars (nodejs/node#63421). The only effective guard is the
// --liftoff-only V8 flag on the node command line, so re-exec once with it
// on affected majors. Drop when upstream fixes.
if (parseInt(process.versions.node, 10) >= 24 && !process.execArgv.includes("--liftoff-only")) {
  const { spawnSync } = require("child_process");
  const r = spawnSync(process.execPath, ["--liftoff-only", __filename, ...process.argv.slice(2)], {
    stdio: "inherit",
  });
  process.exit(r.status ?? 1);
}

require("tsx/cjs");
const cmd = process.argv[2];
if (cmd === "scope") {
  require("../packages/scoper/src/cli.ts");
} else {
  require("../packages/extractor/src/cli.ts");
}
