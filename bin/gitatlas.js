#!/usr/bin/env node
// Global entry: `gitatlas extract .`, `gitatlas scope --trace crash.txt`, and
// `gitatlas site` work from anywhere after npm install -g (or via npx once
// published).

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
const HELP = [
  "Usage: gitatlas <command> [options]",
  "",
  "Commands:",
  "  extract <group-folder>  Build a repository map",
  "  check <group-folder>    Report whether the map is stale (exit 0 fresh, 1 stale)",
  "  brief                   Emit a token-budgeted markdown digest for agent context",
  "  mcp                     Serve the map to AI agents over MCP (stdio)",
  "  scope                   Scope a trace or symbol against a map",
  "  site                    Start the hosted playground",
].join("\n");

switch (cmd) {
  case "extract":
  case "check":
    require("../packages/extractor/src/cli.ts");
    break;
  case "brief":
    require("../packages/brief/src/cli.ts");
    break;
  case "mcp":
    require("../packages/mcp/src/cli.ts");
    break;
  case "scope":
    require("../packages/scoper/src/cli.ts");
    break;
  case "site":
    require("../packages/site/src/start.ts");
    break;
  case "help":
  case "--help":
  case "-h":
    console.log(HELP);
    break;
  case undefined:
    console.error(HELP);
    process.exitCode = 1;
    break;
  default:
    console.error(`Unknown command: ${cmd}`);
    console.error(HELP);
    process.exitCode = 1;
}
