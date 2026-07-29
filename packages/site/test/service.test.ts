/**
 * Tests for the playground's pure core. Node's built-in test runner, no deps.
 * Run via `npm test`, which wires the flags.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseRepoInput, isValidOwner, isValidRepo, repoSlug, shortSha,
  parseLsRemoteHead, planEviction, parseSiteConfig, escapeHtml,
  AdmissionGate, runWithAdmission,
} from "../src/service.ts";

// ── input parsing: every form people actually paste ──

test("parseRepoInput accepts owner/repo", () => {
  assert.deepEqual(parseRepoInput("d3/d3"), { owner: "d3", repo: "d3" });
});

test("parseRepoInput accepts full https URLs, .git, and deeper paths", () => {
  for (const input of [
    "https://github.com/expressjs/express",
    "http://github.com/expressjs/express/",
    "https://www.github.com/expressjs/express.git",
    "github.com/expressjs/express/tree/master/lib",
    "git@github.com:expressjs/express.git",
  ]) {
    assert.deepEqual(parseRepoInput(input), { owner: "expressjs", repo: "express" }, input);
  }
});

test("parseRepoInput keeps dotted repo names like .github", () => {
  assert.deepEqual(parseRepoInput("acme/.github"), { owner: "acme", repo: ".github" });
});

test("parseRepoInput rejects garbage, other hosts, and traversal attempts", () => {
  for (const input of [
    "", "just-one-part", "gitlab.com/foo/bar", "https://gitlab.com/foo/bar",
    "owner/..", "owner/.", "-bad/repo", "owner/re po", "a/b\\c",
  ]) {
    assert.equal(parseRepoInput(input), null, JSON.stringify(input));
  }
});

test("owner and repo validators match GitHub's rules", () => {
  assert.ok(isValidOwner("a"));
  assert.ok(isValidOwner("octo-cat-99"));
  assert.ok(!isValidOwner("-leading"));
  assert.ok(!isValidOwner("trailing-"));
  assert.ok(!isValidOwner("a".repeat(40)));
  assert.ok(isValidRepo("tree-sitter.wasm_v2"));
  assert.ok(!isValidRepo(".."));
  assert.ok(!isValidRepo("has/slash"));
});

// ── cache keys ──

test("repoSlug lowercases (GitHub names are case-insensitive)", () => {
  assert.equal(repoSlug({ owner: "ExpressJS", repo: "Express" }), "expressjs__express");
});

test("shortSha truncates to 12", () => {
  assert.equal(shortSha("0123456789abcdef0123456789abcdef01234567"), "0123456789ab");
});

// ── ls-remote parsing ──

test("parseLsRemoteHead reads the HEAD line", () => {
  const sha = "a".repeat(40);
  assert.equal(parseLsRemoteHead(`${sha}\tHEAD\n${"b".repeat(40)}\trefs/heads/main\n`), sha);
  assert.equal(parseLsRemoteHead("warning: redirecting\n"), null);
  assert.equal(parseLsRemoteHead(""), null);
});

// ── eviction ──

test("planEviction is a no-op under budget", () => {
  const entries = [{ path: "a", mtimeMs: 1, bytes: 10 }, { path: "b", mtimeMs: 2, bytes: 10 }];
  assert.deepEqual(planEviction(entries, 100), []);
});

test("planEviction drops oldest-first until under budget", () => {
  const entries = [
    { path: "new", mtimeMs: 300, bytes: 40 },
    { path: "old", mtimeMs: 100, bytes: 40 },
    { path: "mid", mtimeMs: 200, bytes: 40 },
  ];
  assert.deepEqual(planEviction(entries, 80), ["old"]);
  assert.deepEqual(planEviction(entries, 40), ["old", "mid"]);
});

test("planEviction breaks mtime ties on path for determinism", () => {
  const entries = [
    { path: "b", mtimeMs: 100, bytes: 50 },
    { path: "a", mtimeMs: 100, bytes: 50 },
  ];
  assert.deepEqual(planEviction(entries, 50), ["a"]);
});

// ── config ──

test("parseSiteConfig applies defaults and reads overrides", () => {
  const d = parseSiteConfig({});
  assert.equal(d.port, 8130);
  assert.equal(d.maxRepoMb, 200);
  assert.equal(d.concurrency, 1);
  assert.equal(d.maxActiveJobs, 8);
  assert.equal(d.maxRequestsPerMinute, 30);
  const c = parseSiteConfig({
    PORT: "9000",
    GITATLAS_SITE_MAX_REPO_MB: "50",
    GITATLAS_SITE_CLONE_TIMEOUT_S: "10",
    GITATLAS_SITE_MAX_ACTIVE_JOBS: "4",
    GITATLAS_SITE_REQUESTS_PER_MINUTE: "12",
  });
  assert.equal(c.port, 9000);
  assert.equal(c.maxRepoMb, 50);
  assert.equal(c.cloneTimeoutMs, 10_000);
  assert.equal(c.maxActiveJobs, 4);
  assert.equal(c.maxRequestsPerMinute, 12);
});

test("parseSiteConfig ignores junk values", () => {
  const c = parseSiteConfig({ PORT: "banana", GITATLAS_SITE_CACHE_MB: "-5" });
  assert.equal(c.port, 8130);
  assert.equal(c.maxCacheMb, 2048);
});

test("parseSiteConfig accepts only strict integers within documented bounds", () => {
  const cases = [
    { env: "PORT", fallback: 8130, min: 1, max: 65_535, read: (c: ReturnType<typeof parseSiteConfig>) => c.port },
    { env: "GITATLAS_SITE_MAX_REPO_MB", fallback: 200, min: 1, max: 10_240, read: (c: ReturnType<typeof parseSiteConfig>) => c.maxRepoMb },
    { env: "GITATLAS_SITE_CACHE_MB", fallback: 2048, min: 1, max: 1_048_576, read: (c: ReturnType<typeof parseSiteConfig>) => c.maxCacheMb },
    { env: "GITATLAS_SITE_CONCURRENCY", fallback: 1, min: 1, max: 64, read: (c: ReturnType<typeof parseSiteConfig>) => c.concurrency },
    { env: "GITATLAS_SITE_MAX_ACTIVE_JOBS", fallback: 8, min: 1, max: 1024, read: (c: ReturnType<typeof parseSiteConfig>) => c.maxActiveJobs },
    { env: "GITATLAS_SITE_REQUESTS_PER_MINUTE", fallback: 30, min: 1, max: 100_000, read: (c: ReturnType<typeof parseSiteConfig>) => c.maxRequestsPerMinute },
    { env: "GITATLAS_SITE_CLONE_TIMEOUT_S", fallback: 120_000, min: 1, max: 86_400, scale: 1000, read: (c: ReturnType<typeof parseSiteConfig>) => c.cloneTimeoutMs },
    { env: "GITATLAS_SITE_EXTRACT_TIMEOUT_S", fallback: 300_000, min: 1, max: 86_400, scale: 1000, read: (c: ReturnType<typeof parseSiteConfig>) => c.extractTimeoutMs },
    { env: "GITATLAS_SITE_HEAD_TTL_S", fallback: 300_000, min: 1, max: 86_400, scale: 1000, read: (c: ReturnType<typeof parseSiteConfig>) => c.headTtlMs },
  ];
  const malformed = ["10junk", "1.5", "1e2", " 10", "10 ", "0", "-1", "9007199254740992"];

  for (const setting of cases) {
    const scale = setting.scale || 1;
    assert.equal(
      setting.read(parseSiteConfig({ [setting.env]: String(setting.min) })),
      setting.min * scale,
      `${setting.env} minimum`,
    );
    assert.equal(
      setting.read(parseSiteConfig({ [setting.env]: String(setting.max) })),
      setting.max * scale,
      `${setting.env} maximum`,
    );
    for (const value of [...malformed, String(setting.max + 1)]) {
      assert.equal(
        setting.read(parseSiteConfig({ [setting.env]: value })),
        setting.fallback,
        `${setting.env} rejects ${JSON.stringify(value)}`,
      );
    }
  }

  const coupled = parseSiteConfig({
    GITATLAS_SITE_CONCURRENCY: "64",
    GITATLAS_SITE_MAX_ACTIVE_JOBS: "1",
  });
  assert.equal(coupled.maxActiveJobs, 64, "active-job capacity cannot be lower than concurrency");
});

// ── escaping ──

test("escapeHtml neutralizes markup", () => {
  assert.equal(escapeHtml(`<img src=x onerror="1">'&`), "&lt;img src=x onerror=&quot;1&quot;&gt;&#39;&amp;");
});

// -- expensive request admission --

test("server admission returns 503 at capacity without starting more work", async () => {
  const gate = new AdmissionGate({
    maxActiveJobs: 1,
    maxStartsPerWindow: 10,
    windowMs: 60_000,
    now: () => 1_000,
  });
  let releaseFirst!: () => void;
  const firstFinished = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let starts = 0;

  const first = runWithAdmission(gate, 0, async () => {
    starts++;
    await firstFinished;
    return "first";
  });
  const rejected = await runWithAdmission(gate, 0, async () => {
    starts++;
    return "second";
  });

  assert.deepEqual(rejected, {
    allowed: false,
    reason: "capacity",
    status: 503,
    retryAfterSeconds: 15,
  });
  assert.equal(starts, 1);
  releaseFirst();
  assert.deepEqual(await first, { allowed: true, value: "first" });
});

test("server admission returns 429 without starting work until the rate window resets", async () => {
  let now = 1_000;
  const gate = new AdmissionGate({
    maxActiveJobs: 2,
    maxStartsPerWindow: 1,
    windowMs: 60_000,
    now: () => now,
  });
  let starts = 0;
  const start = async () => {
    starts++;
    return starts;
  };

  assert.deepEqual(await runWithAdmission(gate, 0, start), { allowed: true, value: 1 });
  assert.deepEqual(await runWithAdmission(gate, 0, start), {
    allowed: false,
    reason: "rate_limit",
    status: 429,
    retryAfterSeconds: 60,
  });
  assert.equal(starts, 1);

  now += 60_000;
  assert.deepEqual(await runWithAdmission(gate, 0, start), { allowed: true, value: 2 });
});
