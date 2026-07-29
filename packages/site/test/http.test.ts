import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AddressInfo } from "node:net";
import { sendFile, sendPage, sendResponse } from "../src/http.ts";
import { landingPage } from "../src/pages.ts";
import { createPlayground } from "../src/server.ts";
import { parseSiteConfig } from "../src/service.ts";

async function withServer(run: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = http.createServer((req, res) => {
    if (req.url === "/page") {
      sendPage(res, 200, landingPage([]));
      return;
    }
    if (req.url === "/map") {
      sendResponse(
        res,
        200,
        "<!doctype html><style>body{color:black}</style><script>void 0</script>",
        "text/html; charset=utf-8",
        {},
        "map",
      );
      return;
    }
    sendResponse(res, 200, JSON.stringify({ state: "ready" }), "application/json", {}, "data");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

function rawRequest(
  port: number,
  requestPath: string,
  method = "GET",
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: "127.0.0.1",
      port,
      path: requestPath,
      method,
    }, (response) => {
      response.setEncoding("utf8");
      let body = "";
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({
        status: response.statusCode || 0,
        body,
        headers: response.headers,
      }));
    });
    request.on("error", reject);
    request.end();
  });
}

async function withHeadServer(
  run: (port: number, generations: Record<string, number>) => Promise<void>,
): Promise<void> {
  const generations: Record<string, number> = {};
  const routes = {
    "/": { status: 200, type: "text/html; charset=utf-8", profile: "page", body: "landing" },
    "/healthz": { status: 200, type: "text/plain", profile: "data", body: "ok" },
    "/gh/acme/repo/status": { status: 200, type: "application/json", profile: "data", body: '{"state":"ready"}' },
    "/gh/acme/repo": { status: 200, type: "text/html; charset=utf-8", profile: "map", body: "cached map" },
    "/missing": { status: 404, type: "text/html; charset=utf-8", profile: "page", body: "not found" },
  } as const;
  const server = http.createServer((req, res) => {
    const route = routes[req.url as keyof typeof routes];
    if (!route) {
      res.writeHead(500);
      res.end("unknown test route");
      return;
    }
    const body = () => {
      generations[req.url!] = (generations[req.url!] || 0) + 1;
      return route.body;
    };
    try {
      if (route.profile === "page") {
        sendPage(res, route.status, body);
      } else {
        const headers: Record<string, string> = route.profile === "map"
          ? { ETag: '"abc123"', "Cache-Control": "no-cache" }
          : {};
        sendResponse(res, route.status, body, route.type, headers, route.profile);
      }
    } catch (error) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end(String(error));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(port, generations);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

async function withPlayground(
  run: (port: number, stderr: () => string) => Promise<void>,
): Promise<void> {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "gitatlas-http-"));
  const errors: string[] = [];
  const server = createPlayground({
    config: parseSiteConfig({ GITATLAS_SITE_CACHE_DIR: cacheDir }),
    logger: {
      log: () => {},
      error: (message, error) => errors.push([message, error].filter(Boolean).join(" ")),
    },
  });

  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    await run(port, () => errors.join("\n"));
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
    fs.rmSync(cacheDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

const CACHED_SHA = "e".repeat(40);
const CACHED_ETAG = `"${CACHED_SHA.slice(0, 12)}"`;

/**
 * Playground with one map already cached for acme/big. Every child process
 * resolves to CACHED_SHA, so requests hit the cache without touching the network.
 */
async function withCachedMap(
  writeMap: (mapFile: string) => void,
  run: (port: number, events: () => Record<string, unknown>[]) => Promise<void>,
): Promise<void> {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "gitatlas-stream-"));
  const mapFile = path.join(cacheDir, "maps", "acme__big", CACHED_SHA.slice(0, 12), "index.html");
  fs.mkdirSync(path.dirname(mapFile), { recursive: true });
  writeMap(mapFile);
  const messages: string[] = [];
  const server = createPlayground({
    config: parseSiteConfig({ GITATLAS_SITE_CACHE_DIR: cacheDir }),
    processRunner: async () => ({
      code: 0,
      stdout: `${CACHED_SHA}\tHEAD\n`,
      stderr: "",
      timedOut: false,
      sizeLimitExceeded: false,
    }),
    logger: {
      log: (message) => messages.push(message),
      error: (message) => messages.push(message),
    },
  });

  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    await run(port, () => messages.map((message) => JSON.parse(message) as Record<string, unknown>));
  } finally {
    if (server.listening) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
    fs.rmSync(cacheDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

/** Counts response bytes without retaining them, so a large body stays off the test heap. */
function streamRequest(
  port: number,
  requestPath: string,
  method = "GET",
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; bytes: number; chunks: number }> {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, path: requestPath, method, headers }, (response) => {
      let bytes = 0;
      let chunks = 0;
      response.on("data", (chunk: Buffer) => { bytes += chunk.length; chunks++; });
      response.on("end", () => resolve({
        status: response.statusCode || 0,
        headers: response.headers,
        bytes,
        chunks,
      }));
      response.on("error", reject);
    });
    request.on("error", reject);
    request.end();
  });
}

function assertCommonSecurityHeaders(response: Response): string {
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  const csp = response.headers.get("content-security-policy");
  assert.ok(csp);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /base-uri 'none'/);
  return csp;
}

test("HTTP responses use security policies appropriate to pages, maps, and data", async () => {
  await withServer(async (baseUrl) => {
    const page = await fetch(`${baseUrl}/page`);
    const pageCsp = assertCommonSecurityHeaders(page);
    const nonce = pageCsp.match(/script-src 'nonce-([^']+)'/)?.[1];
    assert.ok(nonce);
    assert.ok(pageCsp.includes(`style-src 'nonce-${nonce}'`));
    assert.match(pageCsp, /connect-src 'self'/);
    assert.doesNotMatch(pageCsp, /'unsafe-inline'/);
    const pageBody = await page.text();
    assert.ok(pageBody.includes(`<script nonce="${nonce}">`));
    assert.ok(pageBody.includes(`<style nonce="${nonce}">`));

    const map = await fetch(`${baseUrl}/map`);
    const mapCsp = assertCommonSecurityHeaders(map);
    assert.match(mapCsp, /script-src 'unsafe-inline' https:\/\/cdnjs\.cloudflare\.com/);
    assert.match(mapCsp, /style-src 'unsafe-inline' https:\/\/fonts\.googleapis\.com/);
    assert.match(mapCsp, /font-src https:\/\/fonts\.gstatic\.com/);
    assert.match(mapCsp, /connect-src 'none'/);

    const data = await fetch(`${baseUrl}/data`);
    const dataCsp = assertCommonSecurityHeaders(data);
    assert.match(dataCsp, /^default-src 'none'/);
    assert.doesNotMatch(dataCsp, /'unsafe-inline'/);
  });
});

test("malformed encoded paths return 400 without internal-error logging", {
  timeout: 10_000,
}, async () => {
  await withPlayground(async (port, stderr) => {
    for (const requestPath of ["/%", "/gh/acme/%ZZ", "/gh/acme/%E0%A4%A"]) {
      const response = await rawRequest(port, requestPath);
      assert.equal(response.status, 400, requestPath);
      assert.match(response.body, /invalid|malformed|encoded/i);
    }

    const valid = await rawRequest(port, "/%68ealthz");
    assert.equal(valid.status, 200);
    assert.equal(valid.body, "ok");
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.doesNotMatch(stderr(), /request failed:/);
  });
});

test("cached maps stream with an exact content length, conditional GET, and empty HEAD", {
  timeout: 20_000,
}, async () => {
  const size = 8 * 1024 * 1024;
  await withCachedMap((mapFile) => fs.writeFileSync(mapFile, Buffer.alloc(size, "m")), async (port) => {
    const get = await streamRequest(port, "/gh/acme/big");
    assert.equal(get.status, 200);
    assert.equal(get.bytes, size);
    assert.ok(get.chunks > 1, "the map arrived as a single buffered write");
    assert.equal(get.headers["content-length"], String(size));
    assert.equal(get.headers.etag, CACHED_ETAG);
    assert.equal(get.headers["cache-control"], "no-cache");
    assert.equal(get.headers["content-type"], "text/html; charset=utf-8");
    assert.match(String(get.headers["content-security-policy"]), /script-src 'unsafe-inline'/);

    const head = await streamRequest(port, "/gh/acme/big", "HEAD");
    assert.equal(head.status, 200);
    assert.equal(head.bytes, 0);
    assert.equal(head.headers["content-length"], String(size));
    assert.equal(head.headers.etag, CACHED_ETAG);
    assert.equal(head.headers["cache-control"], get.headers["cache-control"]);
    assert.equal(head.headers["content-security-policy"], get.headers["content-security-policy"]);

    const conditional = await streamRequest(port, "/gh/acme/big", "GET", { "If-None-Match": CACHED_ETAG });
    assert.equal(conditional.status, 304);
    assert.equal(conditional.bytes, 0);
    assert.equal(conditional.headers.etag, CACHED_ETAG);
    assert.equal(conditional.headers["cache-control"], "no-cache");

    const stale = await streamRequest(port, "/gh/acme/big", "GET", { "If-None-Match": '"0123456789ab"' });
    assert.equal(stale.status, 200);
    assert.equal(stale.bytes, size);
  });
});

test("serving a large cached map does not buffer the file in memory", {
  timeout: 30_000,
}, async () => {
  const size = 64 * 1024 * 1024;
  await withCachedMap((mapFile) => fs.writeFileSync(mapFile, Buffer.alloc(size, "m")), async (port) => {
    const before = process.memoryUsage().heapUsed;
    let peak = before;
    const sampler = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().heapUsed);
    }, 2);
    try {
      const get = await streamRequest(port, "/gh/acme/big");
      assert.equal(get.status, 200);
      assert.equal(get.bytes, size);
    } finally {
      clearInterval(sampler);
    }
    const grewBy = peak - before;
    assert.ok(grewBy < size / 2,
      `heap grew by ${Math.round(grewBy / (1024 * 1024))} MB serving a ${size / (1024 * 1024)} MB map`);
  });
});

test("an unreadable cache entry is rebuilt instead of failing the request", {
  timeout: 20_000,
}, async () => {
  // A directory where index.html belongs: a build that died between mkdir and write.
  await withCachedMap((mapFile) => fs.mkdirSync(mapFile), async (port, events) => {
    const response = await streamRequest(port, "/gh/acme/big");
    assert.equal(response.status, 202);
    assert.ok(events().some((event) => event.event === "job_queued"));
    assert.ok(!events().some((event) => event.event === "request_failed"));
  });
});

test("a cached map that vanishes before it is read fails before any headers are sent", {
  timeout: 10_000,
}, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gitatlas-stream-gone-"));
  const file = path.join(dir, "index.html");
  fs.writeFileSync(file, "x".repeat(4096));
  const size = fs.statSync(file).size;
  fs.rmSync(file); // evicted between the stat and the read
  let failure: unknown;
  let headersSentOnFailure: boolean | null = null;

  const server = http.createServer((req, res) => {
    void sendFile(res, file, { size, headers: { ETag: '"abc123"' }, profile: "map" })
      .catch((error) => {
        failure = error;
        headersSentOnFailure = res.headersSent;
        sendResponse(res, 500, "map unavailable", "text/plain", {}, "data");
      });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const response = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(response.status, 500);
    assert.equal(await response.text(), "map unavailable");
    assert.equal(headersSentOnFailure, false, "a truncated map was reported as a success");
    assert.equal((failure as NodeJS.ErrnoException).code, "ENOENT");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("HEAD matches GET metadata without generating or sending response bodies", async () => {
  await withHeadServer(async (port, generations) => {
    for (const requestPath of [
      "/",
      "/healthz",
      "/gh/acme/repo/status",
      "/gh/acme/repo",
      "/missing",
    ]) {
      const get = await rawRequest(port, requestPath);
      assert.notEqual(get.body, "", `${requestPath} GET body`);
      const generatedAfterGet = generations[requestPath];

      const head = await rawRequest(port, requestPath, "HEAD");
      assert.equal(head.status, get.status, `${requestPath} status`);
      assert.equal(head.body, "", `${requestPath} HEAD body`);
      assert.equal(generations[requestPath], generatedAfterGet, `${requestPath} generation`);
      for (const header of [
        "content-type",
        "x-content-type-options",
        "x-frame-options",
        "referrer-policy",
        "permissions-policy",
        "etag",
        "cache-control",
      ]) {
        assert.equal(head.headers[header], get.headers[header], `${requestPath} ${header}`);
      }
      const normalizeNonce = (value: string | string[] | undefined) =>
        (Array.isArray(value) ? value.join(", ") : value)?.replace(/nonce-[^']+/g, "nonce-<value>");
      assert.equal(
        normalizeNonce(head.headers["content-security-policy"]),
        normalizeNonce(get.headers["content-security-policy"]),
        `${requestPath} content-security-policy`,
      );
    }
  });
});
