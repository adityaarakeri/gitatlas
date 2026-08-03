/**
 * gitatlas playground server: map any public GitHub repo at /gh/owner/repo.
 *
 * Flow per request: resolve HEAD with git ls-remote (cached a few minutes),
 * serve the cached map for that commit if it exists, otherwise queue a build:
 * size-monitored shallow clone -> spawn `bin/gitatlas.js extract` in a child
 * process -> cache the self-contained index.html under maps/<slug>/<sha>.
 *
 * Extraction runs in a child process on purpose: crash isolation from buggy
 * grammars, WASM memory reclaimed per build, and bin/gitatlas.js already
 * handles the Node 24 --liftoff-only re-exec.
 *
 * All I/O lives here; the decisions live in service.ts (pure, tested).
 */
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import {
  RepoRef, BuildState, SiteConfig, isValidOwner, isValidRepo, repoSlug,
  shortSha, parseLsRemoteHead, planEviction, CacheEntry, AdmissionGate,
  runWithAdmission,
} from "./service.js";
import {
  buildRepository, directorySize, runProcess, type DirectorySizer, type ProcessRunner,
} from "./build.js";
import { securityHeaders, sendFile, sendPage, sendResponse } from "./http.js";
import { landingPage, buildingPage, errorPage, badRequestPage, RecentMap } from "./pages.js";

export interface PlaygroundLogger {
  log(message: string): void;
  error(message: string, error?: unknown): void;
}

export interface PlaygroundOptions {
  config: SiteConfig;
  now?: () => number;
  processRunner?: ProcessRunner;
  bin?: string;
  logger?: PlaygroundLogger;
  idFactory?: (kind: "request" | "job") => string;
  directorySizer?: DirectorySizer;
}

// Resolve the CLI entry by walking up to the package root (the directory that
// carries bin/gitatlas.js). Counting ".." segments breaks once this file runs
// from the compiled dist/ tree instead of packages/.
function defaultBin(): string {
  for (let dir = __dirname; dir !== path.dirname(dir); dir = path.dirname(dir)) {
    const candidate = path.join(dir, "bin", "gitatlas.js");
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`gitatlas package root not found above ${__dirname}`);
}

export function createPlayground(options: PlaygroundOptions): http.Server {
const { config } = options;
const now = options.now || Date.now;
const processRunner = options.processRunner || runProcess;
const logger = options.logger || console;
const idFactory = options.idFactory || (() => randomUUID());
const directorySizer = options.directorySizer || directorySize;
const cacheDir = path.resolve(config.cacheDir);
const mapsDir = path.join(cacheDir, "maps");
const workDir = path.join(cacheDir, "work");
fs.mkdirSync(mapsDir, { recursive: true });
fs.mkdirSync(workDir, { recursive: true });

const bin = options.bin || defaultBin();
const ERROR_RETRY_MS = 5 * 60 * 1000;

/** A cache hit resolved under admission, streamed once the reservation is released. */
interface CachedMap {
  file: string;
  size: number;
  sha: string;
  headers: Record<string, string>;
}

interface Job {
  id: string;
  requestId: string;
  ref: RepoRef;
  slug: string;
  sha: string;
  state: BuildState;
  error?: string;
  finishedAt?: number;
}

const jobs = new Map<string, Job>();
const queue: string[] = [];
let running = 0;
const headCache = new Map<string, { sha: string; at: number }>();
const admissionGate = new AdmissionGate({
  maxActiveJobs: config.maxActiveJobs,
  maxStartsPerWindow: config.maxRequestsPerMinute,
  windowMs: 60_000,
  now,
});

type LogValue = string | number | boolean;

function logEvent(
  event: string,
  fields: Record<string, LogValue>,
  level: "log" | "error" = "log",
): void {
  logger[level](JSON.stringify({
    timestamp: new Date(now()).toISOString(),
    event,
    ...fields,
  }));
}

// ── child processes ──────────────────────────────────────────────────────────

const GIT_ENV = { GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "echo" };

async function resolveHead(ref: RepoRef): Promise<string | null> {
  const slug = repoSlug(ref);
  const hit = headCache.get(slug);
  if (hit && now() - hit.at < config.headTtlMs) return hit.sha;
  const url = `https://github.com/${ref.owner}/${ref.repo}.git`;
  const r = await processRunner("git", ["ls-remote", url, "HEAD"], 30_000, GIT_ENV);
  const sha = r.code === 0 ? parseLsRemoteHead(r.stdout) : null;
  if (sha) headCache.set(slug, { sha, at: now() });
  return sha;
}

// ── cache helpers ────────────────────────────────────────────────────────────

function mapFile(slug: string, sha: string): string {
  return path.join(mapsDir, slug, shortSha(sha), "index.html");
}

/** Size of a cached map, or null when it is absent or was left half-written. */
async function statCachedMap(file: string): Promise<number | null> {
  try {
    const stat = await fs.promises.stat(file);
    return stat.isFile() ? stat.size : null;
  } catch (error) {
    if (isPathRace(error)) return null;
    throw error;
  }
}

function streamFailureReason(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : "";
  if (code === "ERR_STREAM_PREMATURE_CLOSE") return "client_disconnected";
  if (code === "ENOENT" || code === "ENOTDIR") return "cache_evicted";
  return "read_failed";
}

function latestMeta(slug: string): (RecentMap & { sha: string }) | null {
  const dir = path.join(mapsDir, slug);
  let shas: string[];
  try { shas = fs.readdirSync(dir); } catch { return null; }
  for (const sha of shas) {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, sha, "meta.json"), "utf8"));
      return { owner: meta.owner, repo: meta.repo, extractedAt: meta.extractedAt, sha: meta.sha };
    } catch { /* half-written build, skip */ }
  }
  return null;
}

function recentMaps(): RecentMap[] {
  let slugs: string[];
  try { slugs = fs.readdirSync(mapsDir); } catch { return []; }
  const all: RecentMap[] = [];
  for (const slug of slugs) {
    const meta = latestMeta(slug);
    if (meta) all.push(meta);
  }
  return all.sort((a, b) => (a.extractedAt < b.extractedAt ? 1 : -1)).slice(0, 20);
}

function isPathRace(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return error.code === "ENOENT" || error.code === "ENOTDIR";
}

/**
 * Cache sizes by slug, so eviction costs one readdir plus one stat per cached
 * repo instead of a walk of every cached file. Builds record their own size,
 * and maps built before sizes were recorded are walked once and remembered.
 */
const cacheBytes = new Map<string, number>();

/** Size recorded by a previous build, or null when this map predates recording. */
async function recordedBytes(slugDir: string): Promise<number | null> {
  let shas: string[];
  try {
    shas = await fs.promises.readdir(slugDir);
  } catch (error) {
    if (isPathRace(error)) return 0;
    throw error;
  }
  let total = 0;
  for (const sha of shas) {
    let meta: unknown;
    try {
      meta = JSON.parse(await fs.promises.readFile(path.join(slugDir, sha, "meta.json"), "utf8"));
    } catch {
      return null; // half-written or pre-recording build; measure it instead
    }
    const bytes = (meta as { bytes?: unknown }).bytes;
    if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return null;
    total += bytes;
  }
  return total;
}

async function slugBytes(slug: string): Promise<number> {
  const known = cacheBytes.get(slug);
  if (known !== undefined) return known;
  const slugDir = path.join(mapsDir, slug);
  const bytes = await recordedBytes(slugDir) ?? await directorySizer(slugDir, false);
  cacheBytes.set(slug, bytes);
  return bytes;
}

async function evictIfOver(currentSlug: string, currentBytes: number): Promise<void> {
  cacheBytes.set(currentSlug, currentBytes);
  let slugs: string[];
  try {
    slugs = await fs.promises.readdir(mapsDir);
  } catch (error) {
    if (isPathRace(error)) return;
    throw error;
  }
  const present = new Set(slugs);
  for (const slug of cacheBytes.keys()) {
    if (!present.has(slug)) cacheBytes.delete(slug); // removed outside this process
  }
  const entries: CacheEntry[] = [];
  for (const slug of slugs) {
    if (slug === currentSlug) continue; // never evict what we just built
    const full = path.join(mapsDir, slug);
    try {
      const stat = await fs.promises.stat(full);
      entries.push({ path: full, mtimeMs: stat.mtimeMs, bytes: await slugBytes(slug) });
    } catch (error) {
      if (!isPathRace(error)) throw error;
    }
  }
  const budget = config.maxCacheMb * 1024 * 1024 - currentBytes;
  for (const p of planEviction(entries, Math.max(0, budget))) {
    await fs.promises.rm(p, { recursive: true, force: true });
    cacheBytes.delete(path.basename(p));
    logEvent("cache_evicted", { cache_key: path.basename(p) });
  }
}

// ── build queue ──────────────────────────────────────────────────────────────

function ensureJob(ref: RepoRef, sha: string, requestId: string): Job {
  const slug = repoSlug(ref);
  const existing = jobs.get(slug);
  if (existing) {
    if (existing.state === "queued" || existing.state === "building") return existing;
    if (existing.state === "error" && existing.sha === sha
      && now() - (existing.finishedAt || 0) < ERROR_RETRY_MS) return existing;
  }
  const job: Job = { id: idFactory("job"), requestId, ref, slug, sha, state: "queued" };
  jobs.set(slug, job);
  queue.push(slug);
  logEvent("job_queued", {
    request_id: job.requestId,
    job_id: job.id,
    repo: `${ref.owner}/${ref.repo}`,
    commit: shortSha(sha),
    queue_position: queue.length,
  });
  pump();
  return job;
}

function pump(): void {
  while (running < config.concurrency && queue.length > 0) {
    const slug = queue.shift()!;
    const job = jobs.get(slug);
    if (!job || job.state !== "queued") continue;
    running++;
    job.state = "building";
    logEvent("job_started", {
      request_id: job.requestId,
      job_id: job.id,
      repo: `${job.ref.owner}/${job.ref.repo}`,
      commit: shortSha(job.sha),
    });
    build(job)
      .catch((err) => { job.state = "error"; job.error = String(err); })
      .finally(() => {
        job.finishedAt = now();
        running--;
        pump();
      });
  }
}

async function build(job: Job): Promise<void> {
  const { ref, slug, sha } = job;
  try {
    const built = await buildRepository({
      ref,
      sha,
      workDir,
      mapsDir,
      bin,
      maxRepoBytes: config.maxRepoMb * 1024 * 1024,
      cloneTimeoutMs: config.cloneTimeoutMs,
      extractTimeoutMs: config.extractTimeoutMs,
      runner: processRunner,
      onStage: (stage) => {
        logEvent("job_stage", {
          request_id: job.requestId,
          job_id: job.id,
          repo: `${ref.owner}/${ref.repo}`,
          commit: shortSha(sha),
          stage,
        });
      },
    });
    await evictIfOver(slug, built.bytes);

    job.state = "ready";
    logEvent("job_ready", {
      request_id: job.requestId,
      job_id: job.id,
      repo: `${ref.owner}/${ref.repo}`,
      commit: shortSha(sha),
    });
  } catch (err) {
    job.state = "error";
    job.error = err instanceof Error ? err.message : String(err);
    const timedOut = /timed out/i.test(job.error);
    logEvent(timedOut ? "job_timed_out" : "job_failed", {
      request_id: job.requestId,
      job_id: job.id,
      repo: `${ref.owner}/${ref.repo}`,
      commit: shortSha(sha),
      reason: timedOut ? "timeout" : "build_failed",
    }, "error");
  }
}

// ── http ─────────────────────────────────────────────────────────────────────

const ROUTE_RE = /^\/(?:gh|github\.com)\/([^/]+)\/([^/]+?)(\/status)?\/?$/;

// eslint-disable-next-line @typescript-eslint/no-misused-promises -- errors are converted to HTTP responses below
const server = http.createServer(async (req, res) => {
  const requestId = idFactory("request");
  try {
    if (req.method !== "GET" && req.method !== "HEAD") {
      sendPage(res, 405, () => badRequestPage("Only GET is supported."));
      return;
    }
    let pathname: string;
    try {
      pathname = decodeURIComponent((req.url || "/").split("?")[0]);
    } catch (error) {
      if (!(error instanceof URIError)) throw error;
      sendPage(res, 400, () => badRequestPage("The request path contains malformed percent-encoding."));
      return;
    }

    if (pathname === "/" || pathname === "") {
      sendPage(res, 200, () => landingPage(recentMaps()));
      return;
    }
    if (pathname === "/healthz") {
      sendResponse(res, 200, () => "ok", "text/plain", {}, "data");
      return;
    }

    const m = pathname.match(ROUTE_RE);
    if (!m) {
      sendPage(res, 404, () => badRequestPage("Nothing here. Maps live at /gh/owner/repo."));
      return;
    }
    const [, owner, repoRaw, statusRoute] = m;
    const repo = repoRaw.replace(/\.git$/i, "");
    if (!isValidOwner(owner) || !isValidRepo(repo)) {
      sendPage(res, 400, () => badRequestPage("That does not look like a GitHub owner/repo."));
      return;
    }
    const ref: RepoRef = { owner, repo };
    const slug = repoSlug(ref);

    if (statusRoute) {
      const job = jobs.get(slug);
      if (job && (job.state === "queued" || job.state === "building")) {
        const position = job.state === "queued" ? queue.indexOf(slug) + 1 : 0;
        sendResponse(res, 200, () => JSON.stringify({ state: job.state, position }), "application/json", {}, "data");
      } else if (job && job.state === "error") {
        sendResponse(res, 200, () => JSON.stringify({ state: "error", message: job.error }), "application/json", {}, "data");
      } else {
        sendResponse(res, 200, () => JSON.stringify({ state: latestMeta(slug) ? "ready" : "error" }), "application/json", {}, "data");
      }
      return;
    }

    const activeJob = jobs.get(slug);
    if (activeJob && (activeJob.state === "queued" || activeJob.state === "building")) {
      const position = activeJob.state === "queued" ? queue.indexOf(slug) + 1 : 0;
      sendPage(res, 202, () => buildingPage(owner, repo, activeJob.state, position));
      return;
    }

    // Admission covers the expensive part: HEAD resolution and queueing. A
    // cache hit is streamed after the reservation is released, so a slow client
    // reading a large map cannot hold a build slot.
    const admitted = await runWithAdmission(admissionGate, running + queue.length,
      async (): Promise<CachedMap | null> => {
        const sha = await resolveHead(ref);
        if (!sha) {
          sendPage(res, 404, () => errorPage(owner, repo, "Repo not found. It may be private, renamed, or misspelled. The playground only sees public repos."));
          return null;
        }

        const file = mapFile(slug, sha);
        const size = await statCachedMap(file);
        if (size !== null) {
          const etag = `"${shortSha(sha)}"`;
          const cacheHeaders = { ETag: etag, "Cache-Control": "no-cache" };
          if (req.headers["if-none-match"] === etag) {
            res.writeHead(304, { ...cacheHeaders, ...securityHeaders("map") });
            res.end();
            return null;
          }
          const accessedAt = new Date(now());
          try {
            await fs.promises.utimes(path.join(mapsDir, slug), accessedAt, accessedAt);
          } catch { /* LRU hint only */ }
          return { file, size, sha, headers: cacheHeaders };
        }

        const job = ensureJob(ref, sha, requestId);
        if (job.state === "error") {
          sendPage(res, 502, () => errorPage(owner, repo, job.error || "Build failed."));
          return null;
        }
        const position = job.state === "queued" ? queue.indexOf(slug) + 1 : 0;
        sendPage(res, 202, () => buildingPage(owner, repo, job.state, position));
        return null;
      });

    if (!admitted.allowed) {
      logEvent("request_rejected", {
        request_id: requestId,
        repo: `${ref.owner}/${ref.repo}`,
        reason: admitted.reason,
        status: admitted.status,
      });
      const message = admitted.reason === "capacity"
        ? "The playground is at capacity. Try again shortly."
        : "Too many new maps were requested. Try again shortly.";
      sendPage(res, admitted.status, () => errorPage(owner, repo, message),
        { "Retry-After": String(admitted.retryAfterSeconds) });
      return;
    }

    const cached = admitted.value;
    if (!cached) return;
    try {
      await sendFile(res, cached.file, {
        size: cached.size,
        headers: cached.headers,
        profile: "map",
      });
    } catch (error) {
      logEvent("map_stream_failed", {
        request_id: requestId,
        repo: `${ref.owner}/${ref.repo}`,
        commit: shortSha(cached.sha),
        reason: streamFailureReason(error),
      }, "error");
      // Nothing is written until the file opens, so a map that vanished between
      // the stat and the read still gets a real answer.
      if (res.headersSent) {
        res.destroy();
        return;
      }
      sendPage(res, 500, () => errorPage(owner, repo,
        "That cached map could not be read. Try again in a moment."));
    }
  } catch {
    logEvent("request_failed", {
      request_id: requestId,
      reason: "internal_error",
      status: 500,
    }, "error");
    // Headers are already on the wire once a map starts streaming; the only
    // honest signal left is an aborted transfer.
    if (res.headersSent) {
      res.destroy();
      return;
    }
    sendPage(res, 500, () => badRequestPage("Something broke on our side. Try again in a minute."));
  }
});

return server;
}
