import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { RepoRef, repoSlug, shortSha } from "./service.js";

export interface ProcessMonitor {
  intervalMs: number;
  isLimitExceeded: () => boolean | Promise<boolean>;
}

export interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  sizeLimitExceeded: boolean;
}

export type ProcessRunner = (
  cmd: string,
  args: string[],
  timeoutMs: number,
  extraEnv?: Record<string, string>,
  monitor?: ProcessMonitor,
  maxOutputBytes?: number,
) => Promise<ProcessResult>;

export const DEFAULT_PROCESS_OUTPUT_BYTES = 64 * 1024;

function appendOutputTail(current: Buffer, data: Buffer | string, maxBytes: number): Buffer {
  if (maxBytes <= 0) return Buffer.alloc(0);
  const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (chunk.length >= maxBytes) {
    // Copy the tail so a small retained slice does not keep a large chunk alive.
    return Buffer.from(chunk.subarray(chunk.length - maxBytes));
  }
  const keepFromCurrent = Math.min(current.length, maxBytes - chunk.length);
  if (keepFromCurrent === 0) return Buffer.from(chunk);
  return Buffer.concat([
    current.subarray(current.length - keepFromCurrent),
    chunk,
  ], keepFromCurrent + chunk.length);
}

export const runProcess: ProcessRunner = (
  cmd,
  args,
  timeoutMs,
  extraEnv,
  monitor,
  maxOutputBytes = DEFAULT_PROCESS_OUTPUT_BYTES,
) => new Promise((resolve) => {
  const child = spawn(cmd, args, {
    env: { ...process.env, ...extraEnv },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdoutTail: Buffer = Buffer.alloc(0);
  let stderrTail: Buffer = Buffer.alloc(0);
  let timedOut = false;
  let sizeLimitExceeded = false;
  let settled = false;
  let monitorRunning = false;

  const finish = (code: number | null, error?: Error): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timeoutTimer);
    if (monitorTimer) clearInterval(monitorTimer);
    if (error) {
      stderrTail = appendOutputTail(stderrTail, String(error), maxOutputBytes);
    }
    resolve({
      code,
      stdout: stdoutTail.toString("utf8"),
      stderr: stderrTail.toString("utf8"),
      timedOut,
      sizeLimitExceeded,
    });
  };

  const timeoutTimer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeoutMs);
  const monitorTimer = monitor
    ? setInterval(() => {
      if (settled || sizeLimitExceeded || monitorRunning) return;
      monitorRunning = true;
      void (async () => {
        try {
          const exceeded = await monitor.isLimitExceeded();
          if (settled || sizeLimitExceeded || !exceeded) return;
          sizeLimitExceeded = true;
          child.kill("SIGKILL");
        } catch (error) {
          if (settled) return;
          stderrTail = appendOutputTail(stderrTail, String(error), maxOutputBytes);
          child.kill("SIGKILL");
        } finally {
          monitorRunning = false;
        }
      })();
    }, monitor.intervalMs)
    : undefined;

  child.stdout.on("data", (data) => {
    stdoutTail = appendOutputTail(stdoutTail, data, maxOutputBytes);
  });
  child.stderr.on("data", (data) => {
    stderrTail = appendOutputTail(stderrTail, data, maxOutputBytes);
  });
  child.on("error", (error) => finish(null, error));
  child.on("close", (code) => finish(code));
});

function isPathRace(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return error.code === "ENOENT" || error.code === "ENOTDIR";
}

export type DirectorySizer = (dir: string, skipDotGit: boolean) => Promise<number>;

export async function directorySize(dir: string, skipDotGit: boolean): Promise<number> {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isPathRace(error)) return 0;
    throw error;
  }
  for (const entry of entries) {
    if (skipDotGit && entry.name === ".git") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await directorySize(full, skipDotGit);
    } else if (entry.isFile()) {
      try {
        total += (await fs.promises.stat(full)).size;
      } catch (error) {
        // A clone can rename files while the monitor is walking the tree.
        if (!isPathRace(error)) throw error;
      }
    }
  }
  return total;
}

export class RepositorySizeLimitError extends Error {
  constructor(maxBytes: number) {
    const maxMb = Math.max(1, Math.floor(maxBytes / (1024 * 1024)));
    super(`Clone exceeded the ${maxMb} MB playground limit. Run gitatlas locally for repositories this size.`);
    this.name = "RepositorySizeLimitError";
  }
}

export interface BuildResult {
  outDir: string;
  /**
   * Size of the generated map files. Recorded so the server can account for the
   * cache without walking it; meta.json is excluded because it carries the value
   * and so cannot be measured before it is written.
   */
  bytes: number;
}

export interface BuildRepositoryOptions {
  ref: RepoRef;
  sha: string;
  workDir: string;
  mapsDir: string;
  bin: string;
  maxRepoBytes: number;
  cloneTimeoutMs: number;
  extractTimeoutMs: number;
  monitorIntervalMs?: number;
  runner?: ProcessRunner;
  onStage?: (stage: "cloning" | "extracting") => void;
}

export async function buildRepository(options: BuildRepositoryOptions): Promise<BuildResult> {
  const {
    ref,
    sha,
    workDir,
    mapsDir,
    bin,
    maxRepoBytes,
    cloneTimeoutMs,
    extractTimeoutMs,
    monitorIntervalMs = 250,
    runner = runProcess,
    onStage,
  } = options;
  const slug = repoSlug(ref);
  const tmp = fs.mkdtempSync(path.join(workDir, `${slug}-`));

  try {
    const cloneDir = path.join(tmp, ref.repo);
    const url = `https://github.com/${ref.owner}/${ref.repo}.git`;
    onStage?.("cloning");
    const cloneStartedAt = Date.now();
    const monitor = {
      intervalMs: monitorIntervalMs,
      isLimitExceeded: async () => await directorySize(tmp, false) > maxRepoBytes,
    };
    const runCloneStep = async (args: string[]): Promise<ProcessResult> => {
      const remainingMs = cloneTimeoutMs - (Date.now() - cloneStartedAt);
      if (remainingMs <= 0) {
        throw new Error(`Clone timed out after ${cloneTimeoutMs / 1000}s. The repo may be too large for the playground.`);
      }
      const result = await runner(
        "git",
        args,
        remainingMs,
        { GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "echo" },
        monitor,
      );
      if (result.sizeLimitExceeded || await directorySize(tmp, false) > maxRepoBytes) {
        throw new RepositorySizeLimitError(maxRepoBytes);
      }
      if (result.timedOut) {
        throw new Error(`Clone timed out after ${cloneTimeoutMs / 1000}s. The repo may be too large for the playground.`);
      }
      if (result.code !== 0) {
        throw new Error("Clone failed. The repo is private, gone, unreachable, or the resolved commit is no longer available.");
      }
      return result;
    };

    await runCloneStep(["-c", "core.longpaths=true", "init", "--quiet", cloneDir]);
    await runCloneStep([
      "-c", "core.longpaths=true", "-C", cloneDir,
      "fetch", "--depth", "1", "--no-tags", url, sha,
    ]);
    await runCloneStep([
      "-c", "core.longpaths=true", "-C", cloneDir,
      "checkout", "--quiet", "--detach", sha,
    ]);
    const checkedOut = await runCloneStep([
      "-c", "core.longpaths=true", "-C", cloneDir, "rev-parse", "HEAD",
    ]);
    if (checkedOut.stdout.trim().toLowerCase() !== sha.toLowerCase()) {
      throw new Error("Clone verification failed: checked-out commit does not match the resolved commit.");
    }

    const outDir = path.join(mapsDir, slug, shortSha(sha));
    fs.rmSync(outDir, { recursive: true, force: true });
    onStage?.("extracting");
    const extract = await runner(
      process.execPath,
      [bin, "extract", cloneDir, "--out", outDir],
      extractTimeoutMs,
    );
    if (extract.timedOut) {
      throw new Error(`Extraction timed out after ${extractTimeoutMs / 1000}s.`);
    }
    if (extract.code !== 0 || !fs.existsSync(path.join(outDir, "index.html"))) {
      const tail = extract.stderr.trim().split("\n").slice(-3).join(" ").slice(0, 300);
      throw new Error(`Extraction failed.${tail ? ` (${tail})` : ""}`);
    }

    const bytes = await directorySize(outDir, false);
    fs.writeFileSync(path.join(outDir, "meta.json"), JSON.stringify({
      owner: ref.owner,
      repo: ref.repo,
      sha,
      extractedAt: new Date().toISOString(),
      bytes,
    }, null, 2));

    for (const old of fs.readdirSync(path.join(mapsDir, slug))) {
      if (old !== shortSha(sha)) {
        fs.rmSync(path.join(mapsDir, slug, old), { recursive: true, force: true });
      }
    }
    return { outDir, bytes };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
