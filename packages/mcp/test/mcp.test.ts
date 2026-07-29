/**
 * MCP server test: spawn the real server over stdio against a hand-written
 * map and speak JSON-RPC to it. Covers the protocol handshake, every tool,
 * and the freshness gate flipping when the source changes underneath.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { spawn, ChildProcess } from "node:child_process";
import { walk, fingerprintFiles } from "../../extractor/src/extract.ts";

const CLI = path.resolve(import.meta.dirname, "../../../bin/gitatlas.js");

interface RpcResponse {
  id: number;
  result?: {
    protocolVersion?: string;
    serverInfo?: { name: string };
    tools?: { name: string }[];
    content?: { type: string; text: string }[];
    isError?: boolean;
  };
  error?: { code: number; message: string };
}

function makeClient(child: ChildProcess) {
  const pending = new Map<number, (msg: RpcResponse) => void>();
  const rl = readline.createInterface({ input: child.stdout! });
  rl.on("line", (line) => {
    const msg = JSON.parse(line) as RpcResponse;
    if (msg.id != null && pending.has(msg.id)) {
      pending.get(msg.id)!(msg);
      pending.delete(msg.id);
    }
  });
  let seq = 0;
  return function request(method: string, params?: object): Promise<RpcResponse> {
    const id = ++seq;
    child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method} (id ${id})`)), 15_000);
      pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    });
  };
}

/** the JSON payload every data tool wraps in content[0].text */
function payload(msg: RpcResponse): Record<string, unknown> {
  return JSON.parse(msg.result!.content![0].text) as Record<string, unknown>;
}

test("mcp: handshake, tools, and the freshness gate end-to-end", { timeout: 120_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gitatlas-mcp-"));
  const repoDir = path.join(root, "alpha");
  const mapDir = path.join(root, "map");
  const appFile = path.join(repoDir, "src", "app.ts");
  fs.mkdirSync(path.dirname(appFile), { recursive: true });
  fs.mkdirSync(mapDir, { recursive: true });
  fs.writeFileSync(appFile, "export function charge() { return helper(); }\nfunction helper() { return 1; }\n");

  const moduleId = "alpha:src/app.ts";
  const graph = {
    schemaVersion: "0.1.0",
    repo: "alpha",
    root: repoDir,
    language: ["typescript"],
    generatedAt: "2026-01-01T00:00:00.000Z",
    sourceFingerprint: fingerprintFiles(repoDir, walk(repoDir, [])),
    modules: [{ id: moduleId, path: "src/app.ts", repo: "alpha", symbolCount: 2, loc: 2, neighborhood: 0, degree: 0, hub: false }],
    symbols: [
      { id: `${moduleId}:charge`, name: "charge", kind: "function", module: moduleId, line: 1, exported: true, refCount: 1 },
      { id: `${moduleId}:helper`, name: "helper", kind: "function", module: moduleId, line: 2, exported: false, refCount: 1 },
    ],
    edges: [{ from: `${moduleId}:charge`, to: `${moduleId}:helper`, kind: "calls", confidence: "resolved" }],
    neighborhoodLabels: { "0": "src" },
  };
  fs.writeFileSync(path.join(mapDir, "alpha.graph.json"), JSON.stringify(graph));
  fs.writeFileSync(path.join(mapDir, "group.json"), JSON.stringify({
    schemaVersion: "0.1.0", group: "lab", generatedAt: graph.generatedAt,
    repos: [{ name: "alpha", graphFile: "alpha.graph.json", moduleCount: 1, symbolCount: 2 }],
    edges: [],
  }));

  const child = spawn(process.execPath, ["--liftoff-only", CLI, "mcp", "--out", mapDir], {
    cwd: path.dirname(CLI),
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", (chunk) => { stderr += chunk; });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const request = makeClient(child);

  try {
    const init = await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
    assert.equal(init.result?.serverInfo?.name, "gitatlas", stderr);
    assert.equal(init.result?.protocolVersion, "2025-06-18");

    const list = await request("tools/list");
    assert.deepEqual(
      list.result?.tools?.map((t) => t.name).sort(),
      ["brief", "check_freshness", "find_symbol", "module_info", "scope"],
    );

    // fresh map: data tools answer without a stale warning
    const found = await request("tools/call", { name: "find_symbol", arguments: { name: "charge" } });
    const foundBody = payload(found);
    assert.equal(foundBody.stale_warning, undefined);
    const matches = foundBody.matches as { file: string; line: number; repo: string }[];
    assert.equal(matches.length, 1);
    assert.equal(matches[0].file, "src/app.ts");

    const freshCheck = payload(await request("tools/call", { name: "check_freshness", arguments: {} }));
    assert.equal(freshCheck.fresh, true, stderr);

    const scoped = payload(await request("tools/call", { name: "scope", arguments: { symbol: "charge" } }));
    assert.equal((scoped.anchor as { resolved: string }).resolved, `${moduleId}:charge`);
    assert.ok((scoped.suspects as unknown[]).length >= 2, "the call edge pulls helper into scope");

    const modInfo = payload(await request("tools/call", { name: "module_info", arguments: { module: "src/app.ts" } }));
    assert.equal(modInfo.id, moduleId);
    assert.equal(modInfo.neighborhood, "src");
    assert.equal((modInfo.symbols as { items: unknown[] }).items.length, 2);

    const briefMsg = await request("tools/call", { name: "brief", arguments: {} });
    assert.match(briefMsg.result!.content![0].text, /# lab: architecture brief/);
    assert.doesNotMatch(briefMsg.result!.content![0].text, /WARNING/);

    // edit the source: check_freshness recomputes, and later tools warn
    fs.writeFileSync(appFile, "export function charge() { return 2; }\n");
    const staleCheck = payload(await request("tools/call", { name: "check_freshness", arguments: {} }));
    assert.equal(staleCheck.fresh, false);
    assert.deepEqual(staleCheck.repos, [{ repo: "alpha", status: "stale" }]);

    const warned = payload(await request("tools/call", { name: "find_symbol", arguments: { name: "charge" } }));
    assert.match(String(warned.stale_warning), /alpha/);

    const staleBrief = await request("tools/call", { name: "brief", arguments: {} });
    assert.match(staleBrief.result!.content![0].text, /WARNING: the map is stale for alpha/);

    // protocol errors: unknown method with an id, unknown tool
    const badMethod = await request("no/such/method");
    assert.equal(badMethod.error?.code, -32601);
    const badTool = await request("tools/call", { name: "no_such_tool", arguments: {} });
    assert.equal(badTool.error?.code, -32602);
  } finally {
    child.kill();
    await exited;
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
