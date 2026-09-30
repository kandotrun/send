import {
  CHUNK_BYTES,
  type CreateRequest,
  ENVELOPE_OVERHEAD,
  MAX_MANIFEST_BYTES,
  MAX_PLAIN_BYTES,
  TTL_OPTIONS,
} from "../shared/protocol";

// Workers WebCrypto extension; lib.dom intentionally does not declare this method.
declare global {
  interface SubtleCrypto {
    timingSafeEqual(a: ArrayBuffer | ArrayBufferView, b: ArrayBuffer | ArrayBufferView): boolean;
  }
}

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(code);
  }
}
export const notFound = () => new HttpError(404, "not_found");

export function secure(response: Response): Response {
  const result = new Response(response.body, response);
  result.headers.set("Cache-Control", "no-store");
  result.headers.set("X-Content-Type-Options", "nosniff");
  result.headers.set("Referrer-Policy", "no-referrer");
  result.headers.set("X-Frame-Options", "DENY");
  result.headers.set(
    "Content-Security-Policy",
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'",
  );
  result.headers.delete("Access-Control-Allow-Origin");
  result.headers.delete("Access-Control-Allow-Credentials");
  return result;
}

export function appOrigin(env: Env): URL {
  let origin: URL;
  try {
    origin = new URL(env.APP_ORIGIN);
  } catch {
    throw new HttpError(503, "unavailable");
  }
  if (
    origin.origin !== env.APP_ORIGIN ||
    origin.username ||
    origin.password ||
    !(
      origin.protocol === "https:" ||
      (origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname))
    )
  ) {
    throw new HttpError(503, "unavailable");
  }
  return origin;
}

export function sameOrigin(request: Request, env: Env): URL {
  const configured = appOrigin(env);
  const url = new URL(request.url);
  const origin = request.headers.get("Origin");
  const host = request.headers.get("Host");
  if (
    url.origin !== configured.origin ||
    (host !== null && host !== configured.host) ||
    (origin !== null && origin !== configured.origin) ||
    request.headers.get("Sec-Fetch-Site") === "cross-site" ||
    (["POST", "PUT", "DELETE"].includes(request.method) && origin !== configured.origin)
  ) {
    throw new HttpError(403, "forbidden");
  }
  return url;
}

export function decodeBase64url(value: unknown, bytes?: number): Uint8Array<ArrayBuffer> | null {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9_-]+$/.test(value) ||
    value.length % 4 === 1 ||
    (bytes !== undefined && value.length !== Math.ceil((bytes * 4) / 3))
  )
    return null;
  try {
    const raw = atob(
      value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (value.length % 4)) % 4),
    );
    const data = Uint8Array.from(raw, (c) => c.charCodeAt(0));
    if ((bytes !== undefined && data.length !== bytes) || encodeBase64url(data) !== value)
      return null;
    return data;
  } catch {
    return null;
  }
}
export function encodeBase64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
export function requireType(request: Request, type: "json" | "chunk"): void {
  const expected =
    type === "json" ? /^application\/json(?:;\s*charset=utf-8)?$/i : /^application\/octet-stream$/i;
  if (!expected.test(request.headers.get("Content-Type") ?? ""))
    throw new HttpError(415, "unsupported_media_type");
}

// Content-Length is only a hint. Count the actual stream before any storage mutation.
export async function boundedBody(request: Request, limit: number): Promise<Uint8Array> {
  const declared = request.headers.get("Content-Length");
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > limit)
    throw new HttpError(413, "body_too_large");
  const output = new Uint8Array(limit);
  let length = 0;
  const reader = request.body?.getReader();
  if (!reader) return output.slice(0, 0);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > limit - length) {
        await reader.cancel().catch(() => {});
        throw new HttpError(413, "body_too_large");
      }
      output.set(value, length);
      length += value.byteLength;
    }
    return output.slice(0, length);
  } finally {
    reader.releaseLock();
  }
}
export async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  requireType(request, "json");
  const bytes = await boundedBody(request, 16_384);
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (typeof value !== "object" || value === null || Array.isArray(value))
      throw new Error("not_object");
    return value as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "invalid_request");
  }
}

export function validateCreate(value: Record<string, unknown>): CreateRequest {
  const keys = [
    "id",
    "readTokenHash",
    "manageTokenHash",
    "encryptedManifest",
    "cipherBytes",
    "chunkCount",
    "ttlSeconds",
  ];
  if (
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key)) ||
    typeof value.id !== "string" ||
    typeof value.readTokenHash !== "string" ||
    typeof value.manageTokenHash !== "string" ||
    !decodeBase64url(value.id, 16) ||
    !decodeBase64url(value.readTokenHash, 32) ||
    !decodeBase64url(value.manageTokenHash, 32) ||
    value.readTokenHash === value.manageTokenHash ||
    typeof value.encryptedManifest !== "string" ||
    value.encryptedManifest.length > Math.ceil((MAX_MANIFEST_BYTES * 4) / 3) ||
    typeof value.cipherBytes !== "number" ||
    !Number.isSafeInteger(value.cipherBytes) ||
    typeof value.chunkCount !== "number" ||
    !Number.isSafeInteger(value.chunkCount) ||
    value.chunkCount < 1 ||
    value.chunkCount > Math.ceil(MAX_PLAIN_BYTES / CHUNK_BYTES) ||
    !TTL_OPTIONS.some((ttl) => ttl === value.ttlSeconds)
  )
    throw new HttpError(400, "invalid_request");
  const manifest = decodeBase64url(value.encryptedManifest);
  const plainBytes = value.cipherBytes - ENVELOPE_OVERHEAD * value.chunkCount;
  if (
    !manifest ||
    manifest.length < ENVELOPE_OVERHEAD ||
    manifest.length > MAX_MANIFEST_BYTES ||
    plainBytes < 0 ||
    plainBytes > MAX_PLAIN_BYTES ||
    Math.max(1, Math.ceil(plainBytes / CHUNK_BYTES)) !== value.chunkCount
  )
    throw new HttpError(400, "invalid_request");
  const ttlSeconds = TTL_OPTIONS.find((ttl) => ttl === value.ttlSeconds);
  if (ttlSeconds === undefined) throw new HttpError(400, "invalid_request");
  return {
    id: value.id,
    readTokenHash: value.readTokenHash,
    manageTokenHash: value.manageTokenHash,
    encryptedManifest: value.encryptedManifest,
    cipherBytes: value.cipherBytes,
    chunkCount: value.chunkCount,
    ttlSeconds,
  };
}

export async function capabilityHash(request: Request): Promise<string> {
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.get("Authorization") ?? "");
  const token = decodeBase64url(match?.[1], 32);
  if (!token) throw notFound();
  return encodeBase64url(new Uint8Array(await crypto.subtle.digest("SHA-256", token)));
}
export function hashMatches(actual: string, expected: string): boolean {
  const a = decodeBase64url(actual, 32);
  const b = decodeBase64url(expected, 32);
  return a !== null && b !== null && crypto.subtle.timingSafeEqual(a, b);
}
export function positiveInteger(value: string): number {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new HttpError(503, "unavailable");
  return Number(value);
}
export function uploadsEnabled(env: Env): boolean {
  try {
    appOrigin(env);
    positiveInteger(env.GLOBAL_BYTE_CAP);
    positiveInteger(env.IP_CREATE_LIMIT);
    positiveInteger(env.GLOBAL_CREATE_LIMIT);
    return (
      env.UPLOADS_ENABLED === "true" &&
      typeof env.RATE_LIMIT_SECRET === "string" &&
      env.RATE_LIMIT_SECRET.length >= 32
    );
  } catch {
    return false;
  }
}
export async function rateIdentity(
  request: Request,
  env: Env,
  now: number,
): Promise<{ ipKey: string; dayKey: string; ipExpires: number; dayExpires: number }> {
  if (!uploadsEnabled(env)) throw new HttpError(503, "unavailable");
  const configured = appOrigin(env);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(configured.hostname);
  const ip = local ? "local-fixture" : request.headers.get("CF-Connecting-IP");
  if (!ip || ip.length > 45 || (!local && !/^[0-9a-fA-F.:]+$/.test(ip)))
    throw new HttpError(503, "unavailable");
  const day = new Date(now).toISOString().slice(0, 10);
  const window = Math.floor(now / 600_000);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.RATE_LIMIT_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${day}\n${ip}`)),
  );
  return {
    ipKey: `ip:${window}:${encodeBase64url(digest)}`,
    dayKey: `day:${day}`,
    ipExpires: (window + 1) * 600_000,
    dayExpires: (Math.floor(now / 86_400_000) + 1) * 86_400_000,
  };
}
