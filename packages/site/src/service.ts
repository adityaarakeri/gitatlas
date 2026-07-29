/**
 * Pure logic for the hosted playground: input parsing, cache keys, config,
 * eviction planning. No I/O here; server.ts owns processes and the filesystem.
 * Mirrors the scoper split (scope.ts pure, cli.ts I/O).
 */

export interface RepoRef {
  owner: string;
  repo: string;
}

// GitHub owner: 1-39 chars, alphanumeric and hyphens, no leading/trailing hyphen.
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
// GitHub repo: alphanumeric, hyphen, underscore, dot (".github" is legal).
// "." and ".." are rejected below; the charset already excludes path separators.
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;

export function isValidOwner(owner: string): boolean {
  return OWNER_RE.test(owner);
}

export function isValidRepo(repo: string): boolean {
  return REPO_RE.test(repo) && repo !== "." && repo !== "..";
}

/**
 * Accepts what people actually paste: "owner/repo", "github.com/owner/repo",
 * "https://github.com/owner/repo", trailing ".git", trailing slash or deeper
 * paths ("/tree/main/..."). Returns null for anything that does not resolve
 * to a plausible GitHub repo.
 */
export function parseRepoInput(input: string): RepoRef | null {
  let s = input.trim();
  if (!s) return null;
  s = s.replace(/^git@github\.com:/i, "");
  s = s.replace(/^[a-z]+:\/\//i, "");
  s = s.replace(/^www\./i, "");
  if (/^github\.com[/:]/i.test(s)) s = s.replace(/^github\.com[/:]/i, "");
  else if (/^[a-z0-9.-]+\.[a-z]{2,}\//i.test(s)) return null; // some other host
  const parts = s.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/i, "");
  if (!isValidOwner(owner) || !isValidRepo(repo)) return null;
  return { owner, repo };
}

/** Cache key: GitHub names are case-insensitive, so the slug is lowercased. */
export function repoSlug(ref: RepoRef): string {
  return `${ref.owner.toLowerCase()}__${ref.repo.toLowerCase()}`;
}

export function shortSha(sha: string): string {
  return sha.slice(0, 12);
}

/** First line of `git ls-remote <url> HEAD` is "<sha>\tHEAD". */
export function parseLsRemoteHead(output: string): string | null {
  const m = output.match(/^([0-9a-f]{40})\s+HEAD\b/m);
  return m ? m[1] : null;
}

export type BuildState = "queued" | "building" | "ready" | "error";

export interface SiteConfig {
  port: number;
  cacheDir: string;
  maxRepoMb: number;
  maxCacheMb: number;
  concurrency: number;
  maxActiveJobs: number;
  maxRequestsPerMinute: number;
  cloneTimeoutMs: number;
  extractTimeoutMs: number;
  headTtlMs: number;
}

interface IntegerSetting {
  fallback: number;
  max: number;
}

const INTEGER_SETTINGS = {
  port: { fallback: 8130, max: 65_535 },
  maxRepoMb: { fallback: 200, max: 10_240 },
  maxCacheMb: { fallback: 2048, max: 1_048_576 },
  concurrency: { fallback: 1, max: 64 },
  maxActiveJobs: { fallback: 8, max: 1024 },
  maxRequestsPerMinute: { fallback: 30, max: 100_000 },
  cloneTimeoutSeconds: { fallback: 120, max: 86_400 },
  extractTimeoutSeconds: { fallback: 300, max: 86_400 },
  headTtlSeconds: { fallback: 300, max: 86_400 },
} as const satisfies Record<string, IntegerSetting>;

function intEnv(value: string | undefined, setting: IntegerSetting): number {
  if (value === undefined || !/^\d+$/.test(value)) return setting.fallback;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 1 && n <= setting.max ? n : setting.fallback;
}

export function parseSiteConfig(env: Record<string, string | undefined>): SiteConfig {
  const concurrency = intEnv(env.GITATLAS_SITE_CONCURRENCY, INTEGER_SETTINGS.concurrency);
  return {
    port: intEnv(env.PORT, INTEGER_SETTINGS.port),
    cacheDir: env.GITATLAS_SITE_CACHE_DIR || ".gitatlas-site",
    maxRepoMb: intEnv(env.GITATLAS_SITE_MAX_REPO_MB, INTEGER_SETTINGS.maxRepoMb),
    maxCacheMb: intEnv(env.GITATLAS_SITE_CACHE_MB, INTEGER_SETTINGS.maxCacheMb),
    concurrency,
    maxActiveJobs: Math.max(concurrency,
      intEnv(env.GITATLAS_SITE_MAX_ACTIVE_JOBS, INTEGER_SETTINGS.maxActiveJobs)),
    maxRequestsPerMinute: intEnv(env.GITATLAS_SITE_REQUESTS_PER_MINUTE,
      INTEGER_SETTINGS.maxRequestsPerMinute),
    cloneTimeoutMs: intEnv(env.GITATLAS_SITE_CLONE_TIMEOUT_S,
      INTEGER_SETTINGS.cloneTimeoutSeconds) * 1000,
    extractTimeoutMs: intEnv(env.GITATLAS_SITE_EXTRACT_TIMEOUT_S,
      INTEGER_SETTINGS.extractTimeoutSeconds) * 1000,
    headTtlMs: intEnv(env.GITATLAS_SITE_HEAD_TTL_S,
      INTEGER_SETTINGS.headTtlSeconds) * 1000,
  };
}

export interface AdmissionGateOptions {
  maxActiveJobs: number;
  maxStartsPerWindow: number;
  windowMs: number;
  now?: () => number;
}

export type AdmissionRejection = {
  allowed: false;
  reason: "capacity" | "rate_limit";
  status: 429 | 503;
  retryAfterSeconds: number;
};

export type AdmissionResult<T> =
  | { allowed: true; value: T }
  | AdmissionRejection;

/**
 * Reserves capacity before expensive async work starts. Reservations close the
 * gap where many concurrent HEAD lookups could all observe an empty job queue.
 */
export class AdmissionGate {
  private readonly now: () => number;
  private reservations = 0;
  private windowStartedAt: number | null = null;
  private startsInWindow = 0;

  constructor(private readonly options: AdmissionGateOptions) {
    this.now = options.now || Date.now;
  }

  acquire(activeJobs: number): { allowed: true } | AdmissionRejection {
    const now = this.now();
    if (this.windowStartedAt === null || now - this.windowStartedAt >= this.options.windowMs) {
      this.windowStartedAt = now;
      this.startsInWindow = 0;
    }

    if (activeJobs + this.reservations >= this.options.maxActiveJobs) {
      return {
        allowed: false,
        reason: "capacity",
        status: 503,
        retryAfterSeconds: 15,
      };
    }

    if (this.startsInWindow >= this.options.maxStartsPerWindow) {
      const remainingMs = this.windowStartedAt + this.options.windowMs - now;
      return {
        allowed: false,
        reason: "rate_limit",
        status: 429,
        retryAfterSeconds: Math.max(1, Math.ceil(remainingMs / 1000)),
      };
    }

    this.reservations++;
    this.startsInWindow++;
    return { allowed: true };
  }

  release(): void {
    if (this.reservations <= 0) {
      throw new Error("Admission reservation underflow");
    }
    this.reservations--;
  }
}

export async function runWithAdmission<T>(
  gate: AdmissionGate,
  activeJobs: number,
  work: () => Promise<T>,
): Promise<AdmissionResult<T>> {
  const decision = gate.acquire(activeJobs);
  if (!decision.allowed) return decision;
  try {
    return { allowed: true, value: await work() };
  } finally {
    gate.release();
  }
}

export interface CacheEntry {
  path: string;
  mtimeMs: number;
  bytes: number;
}

/**
 * Oldest-first eviction plan: returns the paths to delete so the remaining
 * total fits under maxBytes. Ties break on path so the plan is deterministic.
 */
export function planEviction(entries: CacheEntry[], maxBytes: number): string[] {
  const total = entries.reduce((sum, e) => sum + e.bytes, 0);
  if (total <= maxBytes) return [];
  const sorted = [...entries].sort((a, b) => a.mtimeMs - b.mtimeMs || (a.path < b.path ? -1 : 1));
  const evict: string[] = [];
  let remaining = total;
  for (const e of sorted) {
    if (remaining <= maxBytes) break;
    evict.push(e.path);
    remaining -= e.bytes;
  }
  return evict;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
