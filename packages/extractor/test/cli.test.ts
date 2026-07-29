import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { AddressInfo } from "node:net";

const CLI = path.resolve(import.meta.dirname, "../../../bin/gitatlas.js");

function runCli(args: string[], timeout = 10_000): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ["--liftoff-only", CLI, ...args], {
    cwd: path.dirname(CLI),
    encoding: "utf8",
    timeout,
  });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

async function reservePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  return port;
}

test("CLI dispatches known commands and rejects missing or unknown commands", () => {
  const extract = runCli(["extract"]);
  assert.equal(extract.status, 1);
  assert.match(extract.stderr, /Usage: gitatlas extract/);

  const scope = runCli(["scope"]);
  assert.equal(scope.status, 1);
  assert.match(scope.stderr, /provide --trace/);

  const help = runCli(["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage: gitatlas <command>/);

  const missing = runCli([]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Usage: gitatlas <command>/);
  assert.match(missing.stderr, /extract/);
  assert.match(missing.stderr, /scope/);
  assert.match(missing.stderr, /site/);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gitatlas-cli-"));
  const outDir = path.join(root, "should-not-exist");
  try {
    const typo = runCli(["extrcat", root, "--out", outDir]);
    assert.equal(typo.status, 1);
    assert.match(typo.stderr, /Unknown command: extrcat/);
    assert.match(typo.stderr, /Usage: gitatlas <command>/);
    assert.equal(fs.existsSync(outDir), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("check and extract --if-stale track source changes end-to-end", { timeout: 300_000 }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gitatlas-fresh-"));
  const out = path.join(root, "map");
  try {
    const repoDir = path.join(root, "alpha");
    fs.mkdirSync(path.join(repoDir, ".git"), { recursive: true });
    fs.writeFileSync(path.join(repoDir, "index.ts"), "export function greet() { return 1; }\n");

    // no map yet: stale, and check must not create the out dir
    const before = runCli(["check", root, "--out", out], 60_000);
    assert.equal(before.status, 1, before.stderr);
    assert.equal(fs.existsSync(out), false);

    const first = runCli(["extract", root, "--out", out], 60_000);
    assert.equal(first.status, 0, first.stderr);

    const freshCheck = runCli(["check", root, "--out", out], 60_000);
    assert.equal(freshCheck.status, 0, freshCheck.stderr);
    assert.match(freshCheck.stdout, /map is fresh/);

    // edit a source file: stale, and --json names the repo
    fs.writeFileSync(path.join(repoDir, "index.ts"), "export function greet() { return 2; }\n");
    const staleCheck = runCli(["check", root, "--out", out, "--json"], 60_000);
    assert.equal(staleCheck.status, 1, staleCheck.stderr);
    const report = JSON.parse(staleCheck.stdout);
    assert.equal(report.fresh, false);
    assert.deepEqual(report.repos, [{ name: "alpha", status: "stale" }]);

    // --if-stale re-extracts once, then becomes a no-op
    const regen = runCli(["extract", root, "--out", out, "--if-stale"], 60_000);
    assert.equal(regen.status, 0, regen.stderr);
    assert.match(regen.stdout, /re-extracting/);
    assert.match(regen.stdout, /indexed alpha/);

    const noop = runCli(["extract", root, "--out", out, "--if-stale"], 60_000);
    assert.equal(noop.status, 0, noop.stderr);
    assert.match(noop.stdout, /skipping extraction/);
    assert.doesNotMatch(noop.stdout, /indexed alpha/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("CLI dispatches site to the playground server", { timeout: 10_000 }, async () => {
  const port = await reservePort();
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "gitatlas-cli-site-"));
  const child = spawn(process.execPath, ["--liftoff-only", CLI, "site"], {
    cwd: path.dirname(CLI),
    env: { ...process.env, PORT: String(port), GITATLAS_SITE_CACHE_DIR: cacheDir },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));

  try {
    for (let attempt = 0; attempt < 100 && !stdout.includes("gitatlas playground"); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.match(stdout, new RegExp(`gitatlas playground on http://localhost:${port}`), stderr);
  } finally {
    if (child.exitCode === null) child.kill();
    await exited;
    fs.rmSync(cacheDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
