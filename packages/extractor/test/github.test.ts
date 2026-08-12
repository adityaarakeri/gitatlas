import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { isExplicitRemote, isValidRef, parseRepoInput, parseRepoTarget, refSlug } from "../src/github.ts";
import {
  cloneDirFor,
  defaultCacheRoot,
  ensureClone,
  GitRunner,
  mapDirFromArgs,
  resolveTarget,
  TargetError,
} from "../src/clone.ts";

/** A runner that records what it was asked to do and never touches the network. */
function recordingGit(): { calls: string[][]; git: GitRunner } {
  const calls: string[][] = [];
  const git: GitRunner = (args) => {
    calls.push(args);
    // rev-parse is the only step whose output the caller reads.
    return { code: 0, stdout: args.includes("rev-parse") ? "a".repeat(40) + "\n" : "" };
  };
  return { calls, git };
}

const silent = () => {};

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

test("explicit remotes are told apart from things that could be paths", () => {
  for (const input of [
    "https://github.com/expressjs/express",
    "http://github.com/expressjs/express/",
    "https://www.github.com/expressjs/express.git",
    "github.com/expressjs/express/tree/master/lib",
    "git@github.com:expressjs/express.git",
    "https://gitlab.com/foo/bar",
  ]) {
    assert.equal(isExplicitRemote(input), true, input);
  }
  for (const input of ["expressjs/express", "fixtures", "../sibling", "C:\\repos\\thing", "."]) {
    assert.equal(isExplicitRemote(input), false, input);
  }
});

test("clone directories are cache-rooted and case-folded", () => {
  const dir = cloneDirFor("/cache", { owner: "ExpressJS", repo: "Express" });
  assert.equal(dir, path.join("/cache", "repos", "expressjs", "express"));
  // One repo, one cache entry, whatever casing was typed.
  assert.equal(dir, cloneDirFor("/cache", { owner: "expressjs", repo: "express" }));
});

test("each ref gets its own clone directory, and its own name", () => {
  const base = cloneDirFor("/cache", { owner: "expressjs", repo: "express" });
  const tagged = cloneDirFor("/cache", { owner: "expressjs", repo: "express", ref: "v4.18.2" });
  assert.equal(tagged, path.join("/cache", "repos", "expressjs", "express@v4.18.2"));
  assert.notEqual(tagged, base, "a ref must never overwrite the default branch clone");

  // A rewritten ref carries a hash, so two refs cannot collide on one slug.
  const slashed = cloneDirFor("/cache", { owner: "expressjs", repo: "express", ref: "release/4.x" });
  const dashed = cloneDirFor("/cache", { owner: "expressjs", repo: "express", ref: "release-4.x" });
  assert.notEqual(slashed, dashed);
  assert.match(path.basename(slashed), /^express@release-4\.x-[0-9a-f]{8}$/);
  assert.equal(refSlug("main"), "main");
  assert.equal(refSlug("v4.18.2"), "v4.18.2");
});

test("refs are checked before git sees them", () => {
  for (const ref of ["main", "v4.18.2", "release/4.x", "feature_x", "97f38e8836f8"]) {
    assert.equal(isValidRef(ref), true, ref);
  }
  // A leading dash would reach git as an option, not a ref.
  for (const ref of ["", "--upload-pack=evil", "with space", "a..b", "tip~1", "x^", "refs/", "a//b", "v1.lock", "head@{1}"]) {
    assert.equal(isValidRef(ref), false, ref);
  }
});

test("browser URLs carry the branch or tag they were viewed at", () => {
  assert.deepEqual(parseRepoTarget("https://github.com/expressjs/express/tree/v4.18.2"),
    { owner: "expressjs", repo: "express", ref: "v4.18.2" });
  assert.deepEqual(parseRepoTarget("github.com/expressjs/express/blob/main/lib/router.js"),
    { owner: "expressjs", repo: "express", ref: "main" });
  // Only tree/blob name a ref; other deep paths are just paths.
  assert.deepEqual(parseRepoTarget("https://github.com/expressjs/express/pull/1234"),
    { owner: "expressjs", repo: "express" });
  assert.deepEqual(parseRepoTarget("expressjs/express"), { owner: "expressjs", repo: "express" });
  // The owner/repo view drops the ref for callers that map the whole repo.
  assert.deepEqual(parseRepoInput("https://github.com/expressjs/express/tree/v4.18.2"),
    { owner: "expressjs", repo: "express" });
});

test("cache root follows GITATLAS_CACHE_DIR, else the home directory", () => {
  assert.equal(defaultCacheRoot({ GITATLAS_CACHE_DIR: "/tmp/atlas" }), "/tmp/atlas");
  assert.equal(defaultCacheRoot({}), path.join(os.homedir(), ".gitatlas"));
});

test("an existing path always wins over the GitHub reading of it", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gitatlas-target-"));
  const owner = path.join(root, "owner");
  fs.mkdirSync(path.join(owner, "repo"), { recursive: true });
  const { calls, git: recorder } = recordingGit();
  try {
    const resolved = resolveTarget(path.join(owner, "repo"), { git: recorder, log: silent });
    assert.equal(resolved, path.join(owner, "repo"));
    assert.equal(calls.length, 0, "a local folder must not reach for git");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("unusable targets report what is wrong instead of cloning", () => {
  const { calls, git: recorder } = recordingGit();
  const options = { git: recorder, log: silent };

  assert.throws(() => resolveTarget("https://gitlab.com/foo/bar", options), (error: Error) => {
    assert.ok(error instanceof TargetError);
    assert.match(error.message, /not a GitHub repo/);
    return true;
  });
  assert.throws(() => resolveTarget("no-such-folder-here", options), (error: Error) => {
    assert.ok(error instanceof TargetError);
    assert.match(error.message, /no such folder/);
    return true;
  });
  assert.equal(calls.length, 0);
});

test("a bare owner/repo that is not on disk is read as a GitHub repo", () => {
  const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gitatlas-cache-"));
  const { calls, git: recorder } = recordingGit();
  const notes: string[] = [];
  try {
    const dir = resolveTarget("expressjs/express", {
      cacheRoot,
      git: recorder,
      log: (message) => notes.push(message),
    });

    assert.equal(dir, cloneDirFor(cacheRoot, { owner: "expressjs", repo: "express" }));
    assert.ok(notes.some((n) => /reading it as the GitHub repo expressjs\/express/.test(n)),
      "the guess must be stated, not silent");
    assert.deepEqual(calls[1],
      ["-C", dir, "remote", "add", "origin", "https://github.com/expressjs/express.git"]);
  } finally {
    fs.rmSync(cacheRoot, { recursive: true, force: true });
  }
});

test("a ref reaches git as the fetched refspec, from the flag or from the URL", () => {
  const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gitatlas-ref-"));
  try {
    const fetched = (argv: string[], options: { ref?: string } = {}): string[] => {
      const { calls, git } = recordingGit();
      resolveTarget(argv[0], { cacheRoot, git, log: silent, ...options });
      return calls.find((c) => c.includes("fetch"))!;
    };

    assert.ok(fetched(["acme/widget"]).includes("HEAD"), "no ref means the default branch");
    assert.ok(fetched(["acme/widget"], { ref: "v1.2.3" }).includes("v1.2.3"));
    assert.ok(fetched(["https://github.com/acme/widget/tree/beta"]).includes("beta"));

    // The flag wins over the URL, and the disagreement is stated.
    const notes: string[] = [];
    const { calls, git } = recordingGit();
    resolveTarget("https://github.com/acme/widget/tree/beta", {
      cacheRoot, git, ref: "v1.2.3", log: (message) => notes.push(message),
    });
    assert.ok(calls.find((c) => c.includes("fetch"))!.includes("v1.2.3"));
    assert.ok(notes.some((n) => /URL names "beta" but --ref says "v1\.2\.3"/.test(n)),
      "a ref conflict must be announced, not absorbed");
  } finally {
    fs.rmSync(cacheRoot, { recursive: true, force: true });
  }
});

test("a ref that git could misread, or that names nothing, is refused up front", () => {
  const { calls, git } = recordingGit();
  const options = { git, log: silent };

  assert.throws(() => resolveTarget("acme/widget", { ...options, ref: "--upload-pack=evil" }),
    (error: Error) => {
      assert.ok(error instanceof TargetError);
      assert.match(error.message, /not a usable git ref/);
      return true;
    });

  // A ref means nothing for a folder, so saying both is a mistake worth naming.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gitatlas-ref-folder-"));
  try {
    assert.throws(() => resolveTarget(root, { ...options, ref: "main" }),
      /--ref names a branch, tag, or commit of a GitHub repo/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  assert.equal(calls.length, 0, "nothing may run before the ref is checked");
});

test("a failing git step surfaces the exit code, not a half-built clone", () => {
  const failing: GitRunner = (args) => ({ code: args.includes("fetch") ? 128 : 0, stdout: "" });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gitatlas-clone-fail-"));
  try {
    assert.throws(
      () => ensureClone({ owner: "acme", repo: "missing" }, { cacheRoot: root, git: failing, log: silent }),
      /could not fetch https:\/\/github\.com\/acme\/missing\.git.*git exited 128/s,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ensureClone checks out the remote head, then refreshes the same directory", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gitatlas-clone-"));
  const sourceDir = path.join(root, "source");
  const cacheRoot = path.join(root, "cache");
  fs.mkdirSync(sourceDir);

  try {
    git(sourceDir, "init", "--initial-branch=main");
    git(sourceDir, "config", "user.email", "test@example.com");
    git(sourceDir, "config", "user.name", "GitAtlas Test");
    // github.com serves a bare commit sha; a local remote refuses unless asked.
    git(sourceDir, "config", "uploadpack.allowAnySHA1InWant", "true");
    fs.writeFileSync(path.join(sourceDir, "version.txt"), "first\n");
    git(sourceDir, "add", "version.txt");
    git(sourceDir, "commit", "-m", "first commit");

    // The clone always asks for github.com; the runner points that one argument
    // at a local repo so the test stays offline.
    const url = "https://github.com/acme/widget.git";
    const remoteUrl = pathToFileURL(sourceDir).href;
    const realGit: GitRunner = (args, captureStdout) => {
      const result = spawnSync("git", args.map((arg) => arg === url ? remoteUrl : arg), {
        encoding: "utf8",
        stdio: ["ignore", captureStdout ? "pipe" : "ignore", "ignore"],
      });
      if (result.error) throw result.error;
      return { code: result.status ?? 1, stdout: result.stdout || "" };
    };

    const ref = { owner: "acme", repo: "widget" };
    // git's autocrlf can rewrite line endings on checkout, so compare trimmed.
    const version = (dir: string) => fs.readFileSync(path.join(dir, "version.txt"), "utf8").trim();

    const dir = ensureClone(ref, { cacheRoot, git: realGit, log: silent });
    assert.equal(dir, cloneDirFor(cacheRoot, ref));
    assert.equal(version(dir), "first");
    assert.equal(git(dir, "rev-parse", "HEAD"), git(sourceDir, "rev-parse", "HEAD"));

    const firstSha = git(sourceDir, "rev-parse", "HEAD");
    fs.writeFileSync(path.join(sourceDir, "version.txt"), "second\n");
    git(sourceDir, "commit", "-am", "second commit");

    const again = ensureClone(ref, { cacheRoot, git: realGit, log: silent });
    assert.equal(again, dir, "a refresh reuses the cache entry");
    assert.equal(version(dir), "second");
    assert.equal(git(dir, "rev-parse", "HEAD"), git(sourceDir, "rev-parse", "HEAD"));

    // A tag pinned at the first commit resolves to that commit, in its own
    // directory, leaving the default-branch clone untouched.
    git(sourceDir, "tag", "v1", firstSha);
    const tagged = ensureClone({ ...ref, ref: "v1" }, { cacheRoot, git: realGit, log: silent });
    assert.notEqual(tagged, dir);
    assert.equal(version(tagged), "first");
    assert.equal(git(tagged, "rev-parse", "HEAD"), firstSha);
    assert.equal(version(dir), "second", "the default branch clone must be left alone");

    // A branch works the same way, and so does a bare commit sha.
    git(sourceDir, "branch", "legacy", firstSha);
    const branched = ensureClone({ ...ref, ref: "legacy" }, { cacheRoot, git: realGit, log: silent });
    assert.equal(version(branched), "first");
    assert.notEqual(branched, tagged);

    const pinned = ensureClone({ ...ref, ref: firstSha }, { cacheRoot, git: realGit, log: silent });
    assert.equal(git(pinned, "rev-parse", "HEAD"), firstSha);
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("the read commands find the map for the same target extract was given", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gitatlas-mapdir-"));
  const cache = path.join(root, "cache");
  const folder = path.join(root, "repos");
  fs.mkdirSync(folder);
  try {
    // --out wins outright, and no target at all means the current directory.
    assert.equal(mapDirFromArgs(["brief", "--out", folder], root), folder);
    assert.equal(mapDirFromArgs(["brief"], root), path.join(root, ".gitatlas"));

    // A folder target lands on the same default extract writes to.
    assert.equal(mapDirFromArgs(["brief", "--target", folder], root),
      path.join(folder, ".gitatlas"));

    // A GitHub target lands inside its cached clone.
    assert.equal(
      mapDirFromArgs(["brief", "--target", "expressjs/express", "--cache-dir", cache], root),
      path.join(cloneDirFor(cache, { owner: "expressjs", repo: "express" }), ".gitatlas"),
    );

    // A ref points at that ref's clone, whether it came from the flag or a URL.
    const tagged = path.join(
      cloneDirFor(cache, { owner: "expressjs", repo: "express", ref: "v4.18.2" }), ".gitatlas");
    assert.equal(
      mapDirFromArgs(["brief", "--target", "expressjs/express", "--ref", "v4.18.2", "--cache-dir", cache], root),
      tagged);
    assert.equal(
      mapDirFromArgs(["brief", "--target", "github.com/expressjs/express/tree/v4.18.2", "--cache-dir", cache], root),
      tagged);
    assert.equal(
      mapDirFromArgs(["brief", "--target", "https://github.com/expressjs/express", "--cache-dir", cache], root),
      mapDirFromArgs(["brief", "--target", "expressjs/express", "--cache-dir", cache], root),
    );

    // Reading a map never clones, so nothing may appear on disk here.
    assert.equal(fs.existsSync(cache), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("parseRepoInput still reads the shapes people paste", () => {
  assert.deepEqual(parseRepoInput("https://github.com/expressjs/express/tree/main/lib"),
    { owner: "expressjs", repo: "express" });
  assert.equal(parseRepoInput("just-one-part"), null);
});
