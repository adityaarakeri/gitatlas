/**
 * Turns an `extract`/`check` target into a local directory to walk.
 *
 * A folder is used as-is. A GitHub repo is shallow-cloned into a cache keyed by
 * owner, repo, and ref, then refreshed in place on later runs, so the graphs sit
 * next to a real working tree and `check` / `--if-stale` keep working against it.
 * Each ref gets its own clone, so mapping a branch never disturbs the map of the
 * default branch.
 *
 * The read-only commands (brief, mcp, scope) take the same target through
 * `mapDirFromArgs` so one input names one map everywhere, without cloning.
 *
 * All I/O lives here; the parsing it builds on is pure in github.ts.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import {
  RepoTarget,
  cloneUrl,
  isExplicitRemote,
  isValidRef,
  parseRepoTarget,
  refSlug,
} from "./github.js";

export interface GitResult {
  code: number;
  stdout: string;
}

/** Injected by tests; `captureStdout` is false for steps whose output is noise. */
export type GitRunner = (args: string[], captureStdout: boolean) => GitResult;

/** A target problem the user can fix, reported without a stack trace. */
export class TargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TargetError";
  }
}

export interface CloneOptions {
  cacheRoot?: string;
  git?: GitRunner;
  log?: (message: string) => void;
}

export interface ResolveOptions extends CloneOptions {
  /** Branch, tag, or commit. Wins over a ref carried by the input itself. */
  ref?: string;
}

export function defaultCacheRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.GITATLAS_CACHE_DIR || path.join(os.homedir(), ".gitatlas");
}

/**
 * GitHub names are case-insensitive, so one repo maps to one cache entry. A ref
 * gets its own entry beside it (`express@v4.18.2`), which is also the name the
 * map carries, so a branch map is never mistaken for the default branch's.
 */
export function cloneDirFor(cacheRoot: string, target: RepoTarget): string {
  const repo = target.repo.toLowerCase();
  return path.join(cacheRoot, "repos", target.owner.toLowerCase(),
    target.ref ? `${repo}@${refSlug(target.ref)}` : repo);
}

const runGit: GitRunner = (args, captureStdout) => {
  const result = spawnSync("git", ["-c", "core.longpaths=true", ...args], {
    encoding: "utf8",
    // git reports progress on stderr; let it through so a long clone is visible.
    stdio: ["ignore", captureStdout ? "pipe" : "inherit", "inherit"],
    // Fail instead of blocking on a credential prompt. A configured credential
    // helper or ssh agent still answers, so private repos work when git can
    // already read them.
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (result.error) {
    const error = result.error as NodeJS.ErrnoException;
    throw new TargetError(error.code === "ENOENT"
      ? "git was not found on PATH; install git to map GitHub repos"
      : `could not run git: ${error.message}`);
  }
  return { code: result.status ?? 1, stdout: result.stdout || "" };
};

function step(git: GitRunner, args: string[], captureStdout: boolean, failure: string): GitResult {
  const result = git(args, captureStdout);
  if (result.code !== 0) throw new TargetError(`${failure} (git exited ${result.code})`);
  return result;
}

/**
 * Clone `target` into the cache, or refresh it if it is already there, and
 * return the checked-out directory. Without a ref this tracks the default
 * branch; with one it fetches exactly that branch, tag, or commit.
 */
export function ensureClone(target: RepoTarget, options: CloneOptions = {}): string {
  const {
    cacheRoot = defaultCacheRoot(),
    git = runGit,
    log = console.log,
  } = options;
  const dir = cloneDirFor(cacheRoot, target);
  const url = cloneUrl(target);
  const isNew = !fs.existsSync(path.join(dir, ".git"));

  if (isNew) {
    // An interrupted earlier run can leave a partial directory that no fetch
    // would repair, so start this one from nothing.
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    step(git, ["init", "--quiet", dir], false, `could not initialize a clone in ${dir}`);
    step(git, ["-C", dir, "remote", "add", "origin", url], false, `could not set the origin remote to ${url}`);
  }

  // `--no-tags` only stops tags being followed automatically; an explicit tag
  // ref still resolves, and github.com serves a bare commit sha the same way.
  const wanted = target.ref ?? "HEAD";
  const named = target.ref ? `${url} at ${target.ref}` : url;
  log(`${isNew ? "cloning" : "updating"} ${named}`);
  step(git, ["-C", dir, "fetch", "--depth", "1", "--no-tags", "origin", wanted], false,
    target.ref
      ? `could not fetch ${target.ref} from ${url}. Check that the branch, tag, or commit exists, and that the repo is public or your git credentials can read it.`
      : `could not fetch ${url}. Check the owner and repo name, and that the repo is public or your git credentials can read it.`);
  step(git, ["-C", dir, "checkout", "--quiet", "--detach", "--force", "FETCH_HEAD"], false,
    `could not check out the fetched commit in ${dir}`);
  const head = step(git, ["-C", dir, "rev-parse", "HEAD"], true, `could not read HEAD in ${dir}`);

  const label = target.ref ? `${target.owner}/${target.repo}@${target.ref}` : `${target.owner}/${target.repo}`;
  log(`${label} at ${head.stdout.trim().slice(0, 12)} -> ${dir}`);
  return dir;
}

/**
 * Settle which ref applies: an explicit `--ref` beats one the URL carried, and
 * disagreement is announced rather than absorbed. Both are checked here, so an
 * unusable ref is reported before git ever sees it.
 */
function withRef(parsed: RepoTarget, ref: string | undefined, log: (message: string) => void): RepoTarget {
  const chosen = ref ?? parsed.ref;
  if (!chosen) return parsed;
  if (!isValidRef(chosen)) {
    throw new TargetError(`"${chosen}" is not a usable git ref. Branch, tag, and commit names cannot start with "-" or contain whitespace, "..", or git's revision characters.`);
  }
  if (ref && parsed.ref && parsed.ref !== ref) {
    log(`the URL names "${parsed.ref}" but --ref says "${ref}"; using "${ref}"`);
  }
  return { ...parsed, ref: chosen };
}

/**
 * Where `extract <target>` writes, and so where the read-only commands look.
 * Path arithmetic only: a map that was never extracted cannot be read, so
 * naming a GitHub repo here never clones or fetches anything.
 */
export function resolveMapDir(target: string, cacheRoot = defaultCacheRoot(), ref?: string): string {
  const local = path.resolve(target);
  if (fs.existsSync(local)) {
    if (ref) throw new TargetError(`--ref names a branch, tag, or commit of a GitHub repo, but ${local} is a folder.`);
    return path.join(local, ".gitatlas");
  }
  const parsed = parseRepoTarget(target);
  // Not a folder and not a repo: point at the folder anyway and let the caller
  // report the missing map, which names the path it looked in.
  if (!parsed) return path.join(local, ".gitatlas");
  // Notes go to stderr here: brief writes its digest to stdout.
  return path.join(cloneDirFor(cacheRoot, withRef(parsed, ref, console.error)), ".gitatlas");
}

/**
 * The map directory for the read-only commands (brief, mcp, scope), in
 * precedence order: an explicit `--out`, then `--target` (the folder or GitHub
 * repo that was extracted, with `--ref` if one was extracted), then `.gitatlas`
 * in the current directory.
 */
export function mapDirFromArgs(args: string[], cwd: string = process.cwd()): string {
  const value = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i > -1 ? args[i + 1] : undefined;
  };
  const out = value("--out");
  if (out) return path.resolve(out);
  const target = value("--target");
  if (!target) return path.join(cwd, ".gitatlas");
  const cacheDir = value("--cache-dir");
  return resolveMapDir(target, cacheDir ? path.resolve(cacheDir) : undefined, value("--ref"));
}

/**
 * Resolve a CLI target to a directory. An existing path always wins, so no
 * invocation that worked before starts reaching for the network.
 */
export function resolveTarget(input: string, options: ResolveOptions = {}): string {
  const local = path.resolve(input);
  if (fs.existsSync(local)) {
    if (options.ref) {
      throw new TargetError(`--ref names a branch, tag, or commit of a GitHub repo, but ${local} is a folder.`);
    }
    return local;
  }

  const explicit = isExplicitRemote(input);
  const parsed = parseRepoTarget(input);
  if (!parsed) {
    throw new TargetError(explicit
      ? `"${input}" is not a GitHub repo. Expected github.com/<owner>/<repo>.`
      : `no such folder: ${local}`);
  }
  const log = options.log ?? console.log;
  if (!explicit) {
    log(`no local path "${input}", reading it as the GitHub repo ${parsed.owner}/${parsed.repo}`);
  }
  return ensureClone(withRef(parsed, options.ref, log), options);
}
