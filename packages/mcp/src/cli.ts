#!/usr/bin/env node
/**
 * gitatlas mcp [--out <dir>] [--ignore <glob>]...
 *
 * MCP server over stdio: newline-delimited JSON-RPC 2.0, implementing
 * initialize / tools/list / tools/call. Hand-rolled on purpose, like the site
 * server: the protocol surface we need is four methods, and zero runtime
 * dependencies is a feature of this repo.
 *
 * Freshness: source fingerprints are re-checked (cached for 60s) before every
 * tool call, and graphs are reloaded when group.json changes on disk, so a
 * re-extract is picked up without restarting the server. Stale repos are
 * flagged inside every tool result; check_freshness always recomputes.
 *
 * --ignore should mirror the globs used at extract time so the freshness walk
 * covers the same file set. Protocol and I/O only; tool logic is server.ts.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { globToRegExp } from "../../extractor/src/extract.js";
import { graphFreshness, GraphFreshness } from "../../extractor/src/freshness.js";
import { RepoGraph, GroupManifest } from "../../schema/src/types.js";
import { TOOLS, callTool } from "./server.js";

const SERVER_VERSION = "0.9.0";
const PROTOCOL_VERSION = "2025-06-18";
const FRESHNESS_TTL_MS = 60_000;

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: { protocolVersion?: string; name?: string; arguments?: Record<string, unknown> };
}

function main() {
  const args = process.argv.slice(2);
  if (args[0] !== "mcp") {
    console.error("Usage: gitatlas mcp [--out <dir>] [--ignore <glob>]...");
    process.exit(1);
  }
  const outIdx = args.indexOf("--out");
  const outDir = path.resolve(outIdx > -1 ? args[outIdx + 1] : path.join(process.cwd(), ".gitatlas"));
  const ignore: RegExp[] = [];
  for (let k = 0; k < args.length - 1; k++) {
    if (args[k] === "--ignore") ignore.push(globToRegExp(args[k + 1]));
  }
  const manifestPath = path.join(outDir, "group.json");
  if (!fs.existsSync(manifestPath)) {
    console.error(`no graphs found at ${outDir}. Run: gitatlas extract <folder> first, then start the server.`);
    process.exit(1);
  }

  // ── state: graphs reloaded when group.json changes, freshness cached ──
  let manifest!: GroupManifest;
  let graphs!: RepoGraph[];
  let loadedMtimeMs = -1;
  function loadIfChanged() {
    const mtimeMs = fs.statSync(manifestPath).mtimeMs;
    if (mtimeMs === loadedMtimeMs) return;
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as GroupManifest;
    graphs = manifest.repos.map((r) =>
      JSON.parse(fs.readFileSync(path.join(outDir, r.graphFile), "utf8")) as RepoGraph);
    loadedMtimeMs = mtimeMs;
    freshCheckedAt = 0; // new graphs, old verdict is void
  }
  let freshCheckedAt = 0;
  let freshness: GraphFreshness[] = [];
  function checkFreshness(force: boolean) {
    if (force || Date.now() - freshCheckedAt > FRESHNESS_TTL_MS) {
      freshness = graphFreshness(graphs, { ignore });
      freshCheckedAt = Date.now();
    }
    return freshness;
  }
  loadIfChanged();
  console.error(`gitatlas mcp: serving ${graphs.length} repo(s) from ${outDir}`);

  const respond = (id: number | string | null, body: { result?: unknown; error?: { code: number; message: string } }) => {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, ...body }) + "\n");
  };

  function handle(msg: JsonRpcMessage) {
    const id = msg.id;
    switch (msg.method) {
      case "initialize":
        respond(id ?? null, {
          result: {
            protocolVersion: msg.params?.protocolVersion ?? PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: "gitatlas", version: SERVER_VERSION },
          },
        });
        return;
      case "ping":
        respond(id ?? null, { result: {} });
        return;
      case "tools/list":
        respond(id ?? null, { result: { tools: TOOLS } });
        return;
      case "tools/call": {
        const name = msg.params?.name;
        if (typeof name !== "string" || !TOOLS.some((t) => t.name === name)) {
          respond(id ?? null, { error: { code: -32602, message: `unknown tool: ${String(name)}` } });
          return;
        }
        loadIfChanged();
        const report = checkFreshness(name === "check_freshness");
        const staleRepos = report.filter((f) => f.status !== "fresh").map((f) => f.repo);
        const r = callTool(name, msg.params?.arguments ?? {}, {
          group: manifest.group, graphs, staleRepos, freshness: report,
        });
        respond(id ?? null, {
          result: { content: [{ type: "text", text: r.text }], isError: r.isError ?? false },
        });
        return;
      }
      default:
        // notifications (no id) get no response by JSON-RPC rules
        if (id != null) respond(id, { error: { code: -32601, message: `method not found: ${msg.method}` } });
    }
  }

  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(line) as JsonRpcMessage;
    } catch {
      respond(null, { error: { code: -32700, message: "parse error" } });
      return;
    }
    if (Array.isArray(msg)) {
      respond(null, { error: { code: -32600, message: "batch requests are not supported" } });
      return;
    }
    handle(msg);
  });
  rl.on("close", () => process.exit(0));
}

main();
