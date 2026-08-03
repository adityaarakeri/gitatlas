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

const path = require("path");
const fs = require("fs");

// Prefer the compiled dist/ (what the published tarball ships); fall back to
// running the TypeScript sources through tsx so a git clone works with no
// build step.
const DIST = path.join(__dirname, "..", "dist", "packages");
const useDist = fs.existsSync(DIST);
if (!useDist) require("tsx/cjs");
const base = useDist ? DIST : path.join(__dirname, "..", "packages");
const ext = useDist ? "js" : "ts";
const entry = (pkg, name) => path.join(base, pkg, "src", `${name}.${ext}`);

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
    require(entry("extractor", "cli"));
    break;
  case "brief":
    require(entry("brief", "cli"));
    break;
  case "mcp":
    require(entry("mcp", "cli"));
    break;
  case "scope":
    require(entry("scoper", "cli"));
    break;
  case "site":
    require(entry("site", "start"));
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
