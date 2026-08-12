import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";
import { createPlayground } from "../src/server.ts";
import { directorySize, type ProcessRunner } from "../src/build.ts";
import { parseSiteConfig } from "../src/service.ts";

const SERVER_MODULE = path.resolve(import.meta.dirname, "../src/server.ts");

function request(port: number, requestPath: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path: requestPath }, (response) => {
      response.setEncoding("utf8");
      let body = "";
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode || 0, body }));
    }).on("error", reject);
  });
}

async function reservePort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  return port;
}

test("importing the server module has no listener or filesystem side effects", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gitatlas-import-"));
  const cacheDir = path.join(root, "cache");
  const port = await reservePort();
  // A real file, not --eval: named-export interop for a tsx-transpiled TS
  // module is only reliably synthesized for an import() with a real caller
  // module URL. Under --eval (no caller URL) Node 22 collapses the module to
  // just `default`, unlike Node 24, which carries the named export too.
  const probeScript = path.join(root, "probe.mjs");
  fs.writeFileSync(probeScript, [
    'import net from "node:net";',
    `process.env.PORT = ${JSON.stringify(String(port))};`,
    `process.env.GITATLAS_SITE_CACHE_DIR = ${JSON.stringify(cacheDir)};`,
    `const loaded = await import(${JSON.stringify(pathToFileURL(SERVER_MODULE).href)});`,
    'if (typeof loaded.createPlayground !== "function") process.exit(2);',
    "const probe = net.createServer();",
    `await new Promise((resolve, reject) => probe.once("error", reject).listen(${port}, "127.0.0.1", resolve));`,
    'await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));',
  ].join("\n"));

  try {
    const result = spawnSync(process.execPath, [
      "--liftoff-only",
      "--import", "tsx",
      probeScript,
    ], { cwd: process.cwd(), encoding: "utf8", timeout: 5_000 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(cacheDir), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("createPlayground uses injected clock and process runner and can be closed", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gitatlas-factory-"));
  const cacheDir = path.join(root, "cache");
  const sha = "a".repeat(40);
  let currentTime = 1_000;
  let headResolutions = 0;
  const runner: ProcessRunner = async (cmd, args) => {
    assert.equal(cmd, "git");
    assert.deepEqual(args.slice(0, 1), ["ls-remote"]);
    headResolutions++;
    return {
      code: 0,
      stdout: `${sha}\tHEAD\n`,
      stderr: "",
      timedOut: false,
      sizeLimitExceeded: false,
    };
  };
  const server = createPlayground({
    config: parseSiteConfig({
      GITATLAS_SITE_CACHE_DIR: cacheDir,
      GITATLAS_SITE_HEAD_TTL_S: "10",
    }),
    now: () => currentTime,
    processRunner: runner,
  });

  try {
    assert.equal(server.listening, false);
    assert.equal(fs.existsSync(path.join(cacheDir, "maps")), true);
    assert.equal(fs.existsSync(path.join(cacheDir, "work")), true);
    const mapDir = path.join(cacheDir, "maps", "acme__repo", sha.slice(0, 12));
    fs.mkdirSync(mapDir, { recursive: true });
    fs.writeFileSync(path.join(mapDir, "index.html"), "cached map");
    fs.writeFileSync(path.join(mapDir, "meta.json"), JSON.stringify({
      owner: "acme",
      repo: "repo",
      sha,
      extractedAt: new Date(0).toISOString(),
    }));

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    assert.deepEqual(await request(port, "/gh/acme/repo"), { status: 200, body: "cached map" });
    currentTime += 9_999;
    assert.equal((await request(port, "/gh/acme/repo")).status, 200);
    assert.equal(headResolutions, 1);
    currentTime += 2;
    assert.equal((await request(port, "/gh/acme/repo")).status, 200);
    assert.equal(headResolutions, 2);
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("build lifecycle logs are structured and correlate requests with jobs", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gitatlas-logs-"));
  const cacheDir = path.join(root, "cache");
  const sha = "b".repeat(40);
  const messages: string[] = [];
  const counters = { request: 0, job: 0 };
  const runner: ProcessRunner = async (cmd, args) => {
    if (cmd === "git" && args[0] === "ls-remote") {
      return { code: 0, stdout: `${sha}\tHEAD\n`, stderr: "", timedOut: false, sizeLimitExceeded: false };
    }

    const command = args.join(" ");
    if (command.includes("acme__timeout")) {
      return { code: null, stdout: "", stderr: "", timedOut: true, sizeLimitExceeded: false };
    }
    if (command.includes("acme__failed")) {
      return {
        code: 1,
        stdout: "",
        stderr: `SECRET_CHILD_OUTPUT ${path.join(root, "private", "checkout")}`,
        timedOut: false,
        sizeLimitExceeded: false,
      };
    }
    if (cmd === "git" && args.at(-1) === "HEAD") {
      return { code: 0, stdout: `${sha}\n`, stderr: "", timedOut: false, sizeLimitExceeded: false };
    }
    if (cmd === process.execPath) {
      const outIndex = args.indexOf("--out");
      assert.notEqual(outIndex, -1);
      const outDir = args[outIndex + 1];
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, "index.html"), "map");
    }
    return { code: 0, stdout: "", stderr: "", timedOut: false, sizeLimitExceeded: false };
  };
  const server = createPlayground({
    config: parseSiteConfig({
      GITATLAS_SITE_CACHE_DIR: cacheDir,
      GITATLAS_SITE_REQUESTS_PER_MINUTE: "3",
    }),
    processRunner: runner,
    idFactory: (kind) => `${kind}-${++counters[kind]}`,
    logger: {
      log: (message) => messages.push(message),
      error: (message) => messages.push(message),
    },
  });

  const waitForState = async (port: number, repo: string, expected: "ready" | "error"): Promise<void> => {
    for (let attempt = 0; attempt < 50; attempt++) {
      const response = await request(port, `/gh/acme/${repo}/status`);
      if (JSON.parse(response.body).state === expected) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.fail(`${repo} did not reach ${expected}`);
  };

  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    assert.equal((await request(port, "/gh/acme/ready")).status, 202);
    await waitForState(port, "ready", "ready");
    assert.equal((await request(port, "/gh/acme/timeout")).status, 202);
    await waitForState(port, "timeout", "error");
    assert.equal((await request(port, "/gh/acme/failed")).status, 202);
    await waitForState(port, "failed", "error");
    assert.equal((await request(port, "/gh/acme/rejected")).status, 429);

    const records = messages.map((message) => JSON.parse(message) as Record<string, unknown>);
    const assertCorrelated = (repo: string, terminalEvent: string): void => {
      const events = records.filter((record) => record.repo === `acme/${repo}`);
      const queued = events.find((record) => record.event === "job_queued");
      const started = events.find((record) => record.event === "job_started");
      const terminal = events.find((record) => record.event === terminalEvent);
      assert.ok(queued);
      assert.ok(started);
      assert.ok(terminal);
      assert.match(String(queued.request_id), /^request-\d+$/);
      assert.match(String(queued.job_id), /^job-\d+$/);
      assert.equal(started.request_id, queued.request_id);
      assert.equal(started.job_id, queued.job_id);
      assert.equal(terminal.request_id, queued.request_id);
      assert.equal(terminal.job_id, queued.job_id);
    };
    assertCorrelated("ready", "job_ready");
    assertCorrelated("timeout", "job_timed_out");
    assertCorrelated("failed", "job_failed");
    assert.ok(records.some((record) => record.event === "request_rejected"
      && record.repo === "acme/rejected" && record.reason === "rate_limit" && record.status === 429));
    assert.equal(messages.some((message) => message.includes(root)), false);
    assert.equal(messages.some((message) => message.includes("SECRET_CHILD_OUTPUT")), false);
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
test("cache accounting reads recorded sizes and keeps health and status responsive", {
  timeout: 20_000,
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gitatlas-cache-accounting-"));
  const cacheDir = path.join(root, "cache");
  const mapsDir = path.join(cacheDir, "maps");
  const sha = "c".repeat(40);
  const CACHED_REPOS = 128;
  const CHUNK_BYTES = 2 * 1024;
  const CHUNKS_PER_MAP = 8;
  const UNMEASURED_SLUG = "cached__legacy";
  let accountingStartedResolve!: () => void;
  let releaseAccountingResolve!: () => void;
  const accountingStarted = new Promise<void>((resolve) => { accountingStartedResolve = resolve; });
  const releaseAccounting = new Promise<void>((resolve) => { releaseAccountingResolve = resolve; });
  const walkedDirs: string[] = [];
  const messages: string[] = [];

  // A synthetic cache of maps whose sizes are already recorded in metadata, plus
  // one map written before sizes were recorded, which still needs a real walk.
  fs.mkdirSync(mapsDir, { recursive: true });
  const writeCachedMap = (slug: string, recordBytes: boolean, mtimeSeconds: number): void => {
    const mapDir = path.join(mapsDir, slug, "cachedcommit");
    fs.mkdirSync(mapDir, { recursive: true });
    for (let fileIndex = 0; fileIndex < CHUNKS_PER_MAP; fileIndex++) {
      fs.writeFileSync(path.join(mapDir, `chunk-${fileIndex}.bin`), Buffer.alloc(CHUNK_BYTES));
    }
    fs.writeFileSync(path.join(mapDir, "meta.json"), JSON.stringify({
      owner: "cached",
      repo: slug,
      sha,
      extractedAt: new Date(0).toISOString(),
      ...(recordBytes ? { bytes: CHUNK_BYTES * CHUNKS_PER_MAP } : {}),
    }, null, 2));
    fs.utimesSync(path.join(mapsDir, slug), mtimeSeconds, mtimeSeconds);
  };
  for (let repoIndex = 0; repoIndex < CACHED_REPOS - 1; repoIndex++) {
    writeCachedMap(`cached__repo-${repoIndex}`, true, 1_000 + repoIndex);
  }
  // Newest, so oldest-first eviction keeps it and the second build can prove the
  // measured size was remembered instead of re-walked.
  writeCachedMap(UNMEASURED_SLUG, false, 1_000 + CACHED_REPOS);

  const runner: ProcessRunner = async (cmd, args) => {
    if (cmd === "git" && args[0] === "ls-remote") {
      return { code: 0, stdout: `${sha}\tHEAD\n`, stderr: "", timedOut: false, sizeLimitExceeded: false };
    }
    if (cmd === "git" && args.at(-1) === "HEAD") {
      return { code: 0, stdout: `${sha}\n`, stderr: "", timedOut: false, sizeLimitExceeded: false };
    }
    if (cmd === process.execPath) {
      const outDir = args[args.indexOf("--out") + 1];
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, "index.html"), "map");
    }
    return { code: 0, stdout: "", stderr: "", timedOut: false, sizeLimitExceeded: false };
  };
  const server = createPlayground({
    config: parseSiteConfig({
      GITATLAS_SITE_CACHE_DIR: cacheDir,
      GITATLAS_SITE_CACHE_MB: "1",
    }),
    processRunner: runner,
    logger: {
      log: (message) => messages.push(message),
      error: (message) => messages.push(message),
    },
    directorySizer: async (dir, skipDotGit) => {
      walkedDirs.push(dir);
      if (walkedDirs.length === 1) {
        accountingStartedResolve();
        await releaseAccounting;
      }
      return directorySize(dir, skipDotGit);
    },
  });

  const waitForReady = async (port: number, repo: string): Promise<void> => {
    for (let attempt = 0; attempt < 200; attempt++) {
      const response = await request(port, `/gh/acme/${repo}/status`);
      if (JSON.parse(response.body).state === "ready") return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail(`${repo} did not finish cache accounting`);
  };

  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    assert.equal((await request(port, "/gh/acme/fresh")).status, 202);
    await Promise.race([
      accountingStarted,
      new Promise((_, reject) => setTimeout(() => reject(new Error("cache accounting did not start")), 2_000)),
    ]);

    const responses = await Promise.race([
      Promise.all([
        request(port, "/healthz"),
        request(port, "/gh/acme/fresh/status"),
      ]),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("health or status was blocked by cache accounting")), 250);
      }),
    ]);
    assert.deepEqual(responses[0], { status: 200, body: "ok" });
    assert.equal(responses[1].status, 200);
    assert.equal(JSON.parse(responses[1].body).state, "building");

    releaseAccountingResolve();
    await waitForReady(port, "fresh");

    // Only the map without a recorded size is walked; the other 127 are read from metadata.
    assert.deepEqual(walkedDirs, [path.join(mapsDir, UNMEASURED_SLUG)]);
    const remaining = fs.readdirSync(mapsDir);
    assert.ok(remaining.length < CACHED_REPOS, "over-budget cache entries were not evicted");
    assert.ok(remaining.includes("acme__fresh"), "the map just built was evicted");
    assert.ok(remaining.includes(UNMEASURED_SLUG), "the newest cache entry was evicted first");
    assert.ok(messages.some((message) => JSON.parse(message).event === "cache_evicted"));

    // A second build reuses the remembered sizes instead of walking the cache again.
    assert.equal((await request(port, "/gh/acme/second")).status, 202);
    await waitForReady(port, "second");
    assert.deepEqual(walkedDirs, [path.join(mapsDir, UNMEASURED_SLUG)]);
  } finally {
    releaseAccountingResolve();
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
