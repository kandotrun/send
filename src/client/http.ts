import { TransferError, transferErrorCode } from "../shared/errors";
import { currentOrigin } from "./links";

export function abortCheck(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("転送を中止しました。");
}
export function apiOrigin(): string {
  const origin = currentOrigin();
  if (!origin) throw new Error("送信元を確認できません。ブラウザーで開いてください。");
  const url = new URL(origin);
  if (!["https:", "http:"].includes(url.protocol) || url.origin !== origin)
    throw new Error("送信元が正しくありません。");
  return origin;
}

export async function request(
  origin: string,
  path: string,
  method: string,
  expectedStatus: number,
  token?: string,
  body?: BodyInit,
  contentType?: string,
  signal?: AbortSignal,
): Promise<Response> {
  abortCheck(signal);
  const headers = new Headers();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (method !== "GET") headers.set("Origin", origin);
  if (contentType) headers.set("Content-Type", contentType);
  let response: Response;
  try {
    response = await fetch(`${origin}${path}`, {
      method,
      headers,
      body,
      signal,
      cache: "no-store",
      redirect: "error",
      credentials: "omit",
    });
  } catch {
    abortCheck(signal);
    throw new TransferError("network");
  }
  abortCheck(signal);
  if (response.status !== expectedStatus) {
    await response.body?.cancel().catch(() => undefined);
    if ([401, 403, 404, 410].includes(response.status)) throw new TransferError("unavailable");
    if (response.status === 409) throw new TransferError("conflict");
    if (response.status === 413) throw new TransferError("too-large");
    if (response.status === 429) throw new TransferError("rate-limit");
    // 503は作成受付の失敗だけを分類。読み取り障害を期限切れや送信停止と決めつけない。
    if (response.status === 503 && method === "POST" && path === "/api/transfers")
      throw new TransferError("uploads-disabled");
    throw new TransferError("unknown");
  }
  return response;
}

export async function readBounded(
  response: Response,
  maximum: number,
  contentType: string,
  signal?: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  const declared = response.headers.get("content-length");
  const type = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (
    type !== contentType ||
    (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximum))
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw invalidResponse();
  }
  if (!response.body) throw invalidResponse();
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      abortCheck(signal);
      // 本文の読み取り失敗だけを通信エラーにし、形式・長さの検証とは区別する。
      const part = await reader.read().catch(() => {
        abortCheck(signal);
        throw new TransferError("network");
      });
      abortCheck(signal);
      if (part.done) break;
      length += part.value.length;
      if (length > maximum) throw invalidResponse();
      parts.push(part.value);
    }
    if (declared !== null && Number(declared) !== length) throw invalidResponse();
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.length;
    }
    return bytes;
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    abortCheck(signal);
    if (transferErrorCode(error) === "network") throw error;
    throw invalidResponse();
  } finally {
    reader.releaseLock();
  }
}

export async function readJson(response: Response, signal?: AbortSignal): Promise<unknown> {
  const bytes = await readBounded(response, 16384, "application/json", signal);
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw invalidResponse();
  }
}
export function invalidResponse(): Error {
  return new Error("サーバーの応答または暗号データが正しくありません。");
}
export function record(value: unknown, fields: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== fields.length ||
    fields.some((field) => !Object.hasOwn(value, field))
  )
    throw invalidResponse();
  return value as Record<string, unknown>;
}
export function unixMillis(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}
