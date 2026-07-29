import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  buildRepository, ProcessRunner, RepositorySizeLimitError, runProcess,
} from "../src/build.ts";

const GROWING_CLONE_FIXTURE = [
  "const fs = require('node:fs');",
  "const path = require('node:path');",
  "const dir = process.argv[1];",
  "fs.mkdirSync(dir, { recursive: true });",
  "let n = 0;",
  "setInterval(() => {",
  "  fs.writeFileSync(path.join(dir, 'chunk-' + n++), Buffer.alloc(64 * 1024));",
  "}, 5);",
].join("\n");

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

test("clone growth over the repository cap is killed and cleaned before extraction", {
  timeout: 5_000,
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gitatlas-clone-limit-"));
  const workDir = path.join(root, "work");
  const mapsDir = path.join(root, "maps");
  fs.mkdirSync(workDir);
  fs.mkdirSync(mapsDir);
  let extractionStarts = 0;

  const runner: ProcessRunner = (cmd, args, timeoutMs, extraEnv, monitor) => {
    if (cmd === "git") {
      const cloneDir = args.at(-1)!;
      return runProcess(
        process.execPath,
        ["-e", GROWING_CLONE_FIXTURE, cloneDir],
        timeoutMs,
        extraEnv,
        monitor,
      );
    }
    extractionStarts++;
    return Promise.resolve({
      code: 0,
      stdout: "",
      stderr: "",
      timedOut: false,
      sizeLimitExceeded: false,
    });
  };

  const startedAt = Date.now();
  try {
    await assert.rejects(
      buildRepository({
        ref: { owner: "acme", repo: "growing" },
        sha: "a".repeat(40),
        workDir,
        mapsDir,
        bin: "unused",
        maxRepoBytes: 128 * 1024,
        cloneTimeoutMs: 4_000,
        extractTimeoutMs: 4_000,
        monitorIntervalMs: 5,
        runner,
      }),
      RepositorySizeLimitError,
    );

    assert.ok(Date.now() - startedAt < 3_000, "clone process was not terminated promptly");
    assert.equal(extractionStarts, 0);
    assert.deepEqual(fs.readdirSync(workDir), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("child output capture is bounded and preserves diagnostic tails", async () => {
  const cap = 1024;
  const stdoutTail = "STDOUT_USEFUL_TAIL";
  const stderrTail = "STDERR_USEFUL_TAIL";
  const script = [
    `process.stdout.write("o".repeat(256 * 1024) + "${stdoutTail}");`,
    `process.stderr.write("e".repeat(256 * 1024) + "${stderrTail}");`,
  ].join("\n");

  const result = await runProcess(
    process.execPath,
    ["-e", script],
    4_000,
    undefined,
    undefined,
    cap,
  );

  assert.equal(result.code, 0);
  assert.ok(Buffer.byteLength(result.stdout) <= cap);
  assert.ok(Buffer.byteLength(result.stderr) <= cap);
  assert.ok(result.stdout.endsWith(stdoutTail));
  assert.ok(result.stderr.endsWith(stderrTail));
});

test("build records the generated map size so eviction never rescans the cache", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gitatlas-map-size-"));
  const workDir = path.join(root, "work");
  const mapsDir = path.join(root, "maps");
  fs.mkdirSync(workDir);
  fs.mkdirSync(mapsDir);
  const sha = "d".repeat(40);
  const html = "x".repeat(4096);
  const asset = "y".repeat(512);

  const runner: ProcessRunner = async (cmd, args) => {
    if (cmd === "git" && args.at(-1) === "HEAD") {
      return { code: 0, stdout: `${sha}\n`, stderr: "", timedOut: false, sizeLimitExceeded: false };
    }
    if (cmd === process.execPath) {
      const outDir = args[args.indexOf("--out") + 1];
      fs.mkdirSync(path.join(outDir, "data"), { recursive: true });
      fs.writeFileSync(path.join(outDir, "index.html"), html);
      fs.writeFileSync(path.join(outDir, "data", "graph.json"), asset);
    }
    return { code: 0, stdout: "", stderr: "", timedOut: false, sizeLimitExceeded: false };
  };

  try {
    const built = await buildRepository({
      ref: { owner: "acme", repo: "sized" },
      sha,
      workDir,
      mapsDir,
      bin: "unused",
      maxRepoBytes: 10 * 1024 * 1024,
      cloneTimeoutMs: 10_000,
      extractTimeoutMs: 10_000,
      runner,
    });

    assert.equal(built.bytes, html.length + asset.length);
    const metadata = JSON.parse(fs.readFileSync(path.join(built.outDir, "meta.json"), "utf8"));
    assert.equal(metadata.bytes, built.bytes);
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("build extracts and caches the resolved commit when the default branch moves", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gitatlas-exact-sha-"));
  const remoteDir = path.join(root, "remote.git");
  const sourceDir = path.join(root, "source");
  const workDir = path.join(root, "work");
  const mapsDir = path.join(root, "maps");
  fs.mkdirSync(sourceDir);
  fs.mkdirSync(workDir);
  fs.mkdirSync(mapsDir);

  try {
    git(root, "init", "--bare", remoteDir);
    git(sourceDir, "init", "--initial-branch=main");
    git(sourceDir, "config", "user.email", "test@example.com");
    git(sourceDir, "config", "user.name", "GitAtlas Test");
    fs.writeFileSync(path.join(sourceDir, "version.txt"), "resolved\n");
    git(sourceDir, "add", "version.txt");
    git(sourceDir, "commit", "-m", "resolved commit");
    git(sourceDir, "remote", "add", "origin", pathToFileURL(remoteDir).href);
    git(sourceDir, "push", "--set-upstream", "origin", "main");
    git(root, "--git-dir", remoteDir, "symbolic-ref", "HEAD", "refs/heads/main");
    const remoteUrl = pathToFileURL(remoteDir).href;
    const resolvedSha = git(root, "ls-remote", remoteUrl, "HEAD").split(/\s+/)[0];

    fs.writeFileSync(path.join(sourceDir, "version.txt"), "moved\n");
    git(sourceDir, "commit", "-am", "move default branch");
    git(sourceDir, "push", "origin", "main");
    assert.notEqual(git(sourceDir, "rev-parse", "HEAD"), resolvedSha);

    let extractedSha = "";
    let extractedVersion = "";
    const githubUrl = "https://github.com/acme/moving.git";
    const runner: ProcessRunner = async (cmd, args, timeoutMs, extraEnv, monitor) => {
      if (cmd === "git") {
        return runProcess(
          cmd,
          args.map((arg) => arg === githubUrl ? remoteUrl : arg),
          timeoutMs,
          extraEnv,
          monitor,
        );
      }
      const cloneDir = args[2];
      extractedSha = git(cloneDir, "rev-parse", "HEAD");
      extractedVersion = fs.readFileSync(path.join(cloneDir, "version.txt"), "utf8");
      const outDir = args[args.indexOf("--out") + 1];
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, "index.html"), "map");
      return {
        code: 0,
        stdout: "",
        stderr: "",
        timedOut: false,
        sizeLimitExceeded: false,
      };
    };

    const built = await buildRepository({
      ref: { owner: "acme", repo: "moving" },
      sha: resolvedSha,
      workDir,
      mapsDir,
      bin: "unused",
      maxRepoBytes: 10 * 1024 * 1024,
      cloneTimeoutMs: 10_000,
      extractTimeoutMs: 10_000,
      runner,
    });

    assert.equal(extractedSha, resolvedSha);
    assert.equal(extractedVersion.trim(), "resolved");
    const metadata = JSON.parse(fs.readFileSync(path.join(built.outDir, "meta.json"), "utf8"));
    assert.equal(metadata.sha, resolvedSha);
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});
