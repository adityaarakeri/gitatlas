import * as http from "node:http";
import * as fs from "node:fs";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { pipeline } from "node:stream/promises";

export type ResponseSecurityProfile = "page" | "map" | "data";
export type ResponseBody = string | (() => string);

function resolveBody(body: ResponseBody): string {
  return typeof body === "function" ? body() : body;
}

export function securityHeaders(
  profile: ResponseSecurityProfile,
  nonce?: string,
): Record<string, string> {
  let contentSecurityPolicy: string;
  if (profile === "page") {
    if (!nonce) throw new Error("Page security policy requires a nonce");
    contentSecurityPolicy = [
      "default-src 'none'",
      `script-src 'nonce-${nonce}'`,
      `style-src 'nonce-${nonce}'`,
      "connect-src 'self'",
      "img-src data:",
      "font-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join("; ");
  } else if (profile === "map") {
    contentSecurityPolicy = [
      "default-src 'none'",
      "script-src 'unsafe-inline' https://cdnjs.cloudflare.com",
      "style-src 'unsafe-inline' https://fonts.googleapis.com",
      "font-src https://fonts.gstatic.com",
      "img-src data:",
      "connect-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join("; ");
  } else {
    contentSecurityPolicy = [
      "default-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join("; ");
  }

  return {
    "Content-Security-Policy": contentSecurityPolicy,
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), geolocation=(), microphone=()",
  };
}

export function sendResponse(
  res: http.ServerResponse,
  status: number,
  body: ResponseBody,
  type = "text/html; charset=utf-8",
  headers: Record<string, string> = {},
  profile: ResponseSecurityProfile = "data",
): void {
  res.writeHead(status, {
    "Content-Type": type,
    ...headers,
    ...securityHeaders(profile),
  });
  if (res.req?.method === "HEAD") {
    res.end();
    return;
  }
  res.end(resolveBody(body));
}

export interface FileResponseOptions {
  /** Byte length from a prior stat; sent as Content-Length. */
  size: number;
  status?: number;
  type?: string;
  headers?: Record<string, string>;
  profile?: ResponseSecurityProfile;
}

/**
 * Streams a file to the client so a self-contained map is never held in memory
 * in full. The file is opened before the status line is written, so a missing
 * or unreadable file rejects with nothing sent and the caller can still answer
 * with an error. A rejection after `res.headersSent` means the transfer was cut
 * short; the caller must destroy the response rather than call it a success.
 */
export async function sendFile(
  res: http.ServerResponse,
  filePath: string,
  options: FileResponseOptions,
): Promise<void> {
  const {
    size,
    status = 200,
    type = "text/html; charset=utf-8",
    headers = {},
    profile = "map",
  } = options;
  const responseHeaders = {
    "Content-Type": type,
    "Content-Length": String(size),
    ...headers,
    ...securityHeaders(profile),
  };
  if (res.req?.method === "HEAD") {
    res.writeHead(status, responseHeaders);
    res.end();
    return;
  }
  const file = fs.createReadStream(filePath);
  try {
    await once(file, "open");
  } catch (error) {
    file.destroy();
    throw error;
  }
  res.writeHead(status, responseHeaders);
  await pipeline(file, res);
}

export function sendPage(
  res: http.ServerResponse,
  status: number,
  html: ResponseBody,
  headers: Record<string, string> = {},
): void {
  const nonce = randomBytes(18).toString("base64");
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    ...headers,
    ...securityHeaders("page", nonce),
  });
  if (res.req?.method === "HEAD") {
    res.end();
    return;
  }
  const protectedHtml = resolveBody(html).replace(
    /<(script|style)(?=[\s>])/g,
    `<$1 nonce="${nonce}"`,
  );
  res.end(protectedHtml);
}
