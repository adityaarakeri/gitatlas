/**
 * GitHub target parsing: the shapes a person actually pastes into a CLI or a
 * URL bar, reduced to an owner, a repo, and optionally the branch or tag the
 * URL was viewed at.
 *
 * Pure by design (no filesystem, no processes, no network) so the hosted
 * playground can share it without pulling the extractor's I/O into its import
 * graph. Cloning lives in clone.ts.
 */
import { createHash } from "node:crypto";

export interface RepoRef {
  owner: string;
  repo: string;
}

/** A repo plus the branch, tag, or commit to read. No ref means the default branch. */
export interface RepoTarget extends RepoRef {
  ref?: string;
}

// GitHub owner: 1-39 chars, alphanumeric and hyphens, no leading/trailing hyphen.
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
// GitHub repo: alphanumeric, hyphen, underscore, dot (".github" is legal).
// "." and ".." are rejected below; the charset already excludes path separators.
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
// Whitespace plus the characters git reserves for revision syntax.
const REF_RESERVED_RE = /[\s~^:?*[\\]/;

/**
 * Spellings that can only mean a remote: a URL scheme, the scp-style git@ form,
 * or a bare github.com host. Anything else ("owner/repo") is ambiguous with a
 * relative path, so callers resolve it against the filesystem first.
 */
const EXPLICIT_REMOTE_RE = /^(?:[a-z][a-z0-9+.-]*:\/\/|git@github\.com:|(?:www\.)?github\.com[/:])/i;

export function isValidOwner(owner: string): boolean {
  return OWNER_RE.test(owner);
}

export function isValidRepo(repo: string): boolean {
  return REPO_RE.test(repo) && repo !== "." && repo !== "..";
}

/** True for input that names a remote outright, whatever host it points at. */
export function isExplicitRemote(input: string): boolean {
  return EXPLICIT_REMOTE_RE.test(input.trim());
}

/**
 * A subset of `git check-ref-format`, tight enough that the result is safe as
 * an argv entry. The leading-dash rule matters most: a ref starting with `-`
 * would reach git as an option rather than as a ref.
 */
export function isValidRef(ref: string): boolean {
  if (!ref || ref.length > 255) return false;
  if (ref.startsWith("-") || ref.startsWith("/") || ref.endsWith("/")) return false;
  if (ref.endsWith(".") || ref.endsWith(".lock")) return false;
  if (ref.includes("..") || ref.includes("//") || ref.includes("@{")) return false;
  if (REF_RESERVED_RE.test(ref)) return false;
  for (let i = 0; i < ref.length; i++) {
    const code = ref.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

/**
 * A directory-safe name for a ref. `main` and `v4.18.2` pass through as
 * themselves; anything that has to be rewritten (`release/4.x`) carries a hash
 * of the original, so two different refs can never land in one cache directory.
 */
export function refSlug(ref: string): string {
  const safe = ref.replace(/[^A-Za-z0-9._-]+/g, "-");
  if (safe === ref) return safe;
  return `${safe}-${createHash("sha1").update(ref).digest("hex").slice(0, 8)}`;
}

/**
 * Accepts what people actually paste: "owner/repo", "github.com/owner/repo",
 * "https://github.com/owner/repo", trailing ".git", trailing slash, and the
 * deeper browser paths. A `/tree/<ref>/...` or `/blob/<ref>/...` URL carries
 * the branch or tag it was viewed at, and that ref comes back with the repo.
 *
 * Only the first segment after `tree`/`blob` is read as the ref, because
 * "/tree/release/4.x/src" is ambiguous between a slashed branch name and a
 * directory below it. Those need `--ref`.
 *
 * Returns null for anything that does not resolve to a plausible GitHub repo.
 */
export function parseRepoTarget(input: string): RepoTarget | null {
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
  const ref = /^(?:tree|blob)$/i.test(parts[2] || "") ? parts[3] : undefined;
  return ref ? { owner, repo, ref } : { owner, repo };
}

/** The owner/repo view of a target, for callers that map the whole repo. */
export function parseRepoInput(input: string): RepoRef | null {
  const target = parseRepoTarget(input);
  return target && { owner: target.owner, repo: target.repo };
}

export function cloneUrl(ref: RepoRef): string {
  return `https://github.com/${ref.owner}/${ref.repo}.git`;
}
