import { safeTransferError } from "../shared/errors";
import {
  CHUNK_BYTES,
  type CreatedTransfer,
  type CreateRequest,
  ENVELOPE_OVERHEAD,
  MAX_BUFFERED_BYTES,
  MAX_PLAIN_BYTES,
  type ManageLink,
  type ManageRecord,
  type OpenedTransfer,
  type Progress,
  type ReadLink,
  type TransferInput,
  type TransferOptions,
  TTL_OPTIONS,
  type TtlSeconds,
} from "../shared/protocol";
import {
  decryptChunk,
  decryptManifest,
  deriveKeys,
  encryptChunk,
  encryptManifest,
  generateSecrets,
  hashSecret,
} from "./crypto";
import { assertId, assertSecret, decodeBase64Url, encodeBase64Url } from "./encoding";
import {
  abortCheck,
  apiOrigin,
  invalidResponse,
  readBounded,
  readJson,
  record,
  request,
  unixMillis,
} from "./http";
import {
  buildManageUrl,
  buildReadUrl,
  parseManageLink as parseManagement,
  parseReadLink as parseRead,
} from "./links";
import { validateManifest } from "./manifest";

export function parseReadLink(url: string): ReadLink {
  return parseRead(url);
}
export function parseManageLink(url: string): ManageLink {
  return parseManagement(url);
}
const pathFor = (id: string) => `/api/transfers/${id}`;
const maxChunks = Math.ceil(MAX_PLAIN_BYTES / CHUNK_BYTES);
function progress(callback: TransferOptions["onProgress"], value: Progress): void {
  try {
    callback?.(value);
  } catch {
    throw new Error("進捗の表示に失敗しました。転送を中止しました。");
  }
}
function identity(value: unknown, id: string): { id: string; expiresAt: number } {
  const item = record(value, ["id", "expiresAt"]);
  if (item.id !== id || !unixMillis(item.expiresAt)) throw invalidResponse();
  return { id, expiresAt: item.expiresAt };
}
function readAuthority(link: ReadLink): ReadLink {
  const copy = { id: link.id, readToken: link.readToken, key: link.key };
  assertId(copy.id);
  assertSecret(copy.readToken);
  assertSecret(copy.key);
  return copy;
}
function manageAuthority(link: ManageLink): ManageLink {
  const copy = { id: link.id, manageToken: link.manageToken };
  assertId(copy.id);
  assertSecret(copy.manageToken);
  return copy;
}

export async function createTransfer(
  input: TransferInput,
  ttlSeconds: TtlSeconds,
  options: TransferOptions = {},
): Promise<CreatedTransfer> {
  const { signal, onProgress } = options;
  abortCheck(signal);
  if (!(input.blob instanceof Blob)) throw new Error("ファイルまたはテキストを選択してください。");
  const blob = input.blob;
  if (input.kind === "text" && blob.size > MAX_BUFFERED_BYTES)
    throw new Error("テキストは100 MB以下にしてください。");
  if (blob.size > MAX_PLAIN_BYTES) throw new Error("ファイルは10 GB以下にしてください。");
  if (!TTL_OPTIONS.includes(ttlSeconds))
    throw new Error("有効期限は1時間・1日・7日から選択してください。");
  const secrets = generateSecrets();
  const manifest = validateManifest(
    {
      version: 1,
      id: secrets.id,
      kind: input.kind,
      name: input.name,
      mime: input.mime,
      size: blob.size,
      chunkCount: Math.max(1, Math.ceil(blob.size / CHUNK_BYTES)),
      chunkBytes: CHUNK_BYTES,
      ttlSeconds,
    },
    secrets.id,
  );
  const origin = apiOrigin();
  const keys = await deriveKeys(secrets.key, secrets.id);
  const encryptedManifest = encodeBase64Url(await encryptManifest(keys, manifest));
  const payload: CreateRequest = {
    id: secrets.id,
    encryptedManifest,
    readTokenHash: await hashSecret(secrets.readToken),
    manageTokenHash: await hashSecret(secrets.manageToken),
    cipherBytes: blob.size + ENVELOPE_OVERHEAD * manifest.chunkCount,
    chunkCount: manifest.chunkCount,
    ttlSeconds,
  };
  abortCheck(signal);
  let attempted = false;
  try {
    // 応答を受け取れない場合も、サーバー側で作成済みの可能性がある。
    attempted = true;
    const created = identity(
      await readJson(
        await request(
          origin,
          "/api/transfers",
          "POST",
          201,
          undefined,
          JSON.stringify(payload),
          "application/json",
          signal,
        ),
        signal,
      ),
      secrets.id,
    );
    progress(onProgress, { stage: "uploading", done: 0, total: blob.size });
    for (let index = 0; index < manifest.chunkCount; index++) {
      abortCheck(signal);
      const offset = index * CHUNK_BYTES;
      const plaintext = new Uint8Array(
        await blob.slice(offset, offset + CHUNK_BYTES).arrayBuffer(),
      );
      abortCheck(signal);
      progress(onProgress, { stage: "encrypting", done: offset, total: blob.size });
      const encrypted = await encryptChunk(keys, secrets.id, index, plaintext);
      abortCheck(signal);
      progress(onProgress, {
        stage: "encrypting",
        done: offset + plaintext.length,
        total: blob.size,
      });
      const response = await request(
        origin,
        `${pathFor(secrets.id)}/chunks/${index}`,
        "PUT",
        201,
        secrets.manageToken,
        encrypted,
        "application/octet-stream",
        signal,
      );
      await response.body?.cancel().catch(() => undefined);
      progress(onProgress, {
        stage: "uploading",
        done: offset + plaintext.length,
        total: blob.size,
      });
    }
    abortCheck(signal);
    const complete = identity(
      await readJson(
        await request(
          origin,
          `${pathFor(secrets.id)}/complete`,
          "POST",
          200,
          secrets.manageToken,
          "{}",
          "application/json",
          signal,
        ),
        signal,
      ),
      secrets.id,
    );
    if (complete.expiresAt !== created.expiresAt) throw invalidResponse();
    abortCheck(signal);
    return {
      id: secrets.id,
      expiresAt: complete.expiresAt,
      readUrl: buildReadUrl(origin, secrets),
      manageUrl: buildManageUrl(origin, secrets),
    };
  } catch (error) {
    if (attempted) {
      // 中止されたsignalを再利用しない。失敗時の破棄は独立した短い期限で試す。
      try {
        await request(
          origin,
          pathFor(secrets.id),
          "DELETE",
          204,
          secrets.manageToken,
          undefined,
          undefined,
          AbortSignal.timeout(5000),
        );
      } catch {
        /* 失効処理はbest effort。 */
      }
    }
    abortCheck(signal);
    throw safeTransferError(error);
  }
}

export async function openTransfer(
  link: ReadLink,
  options: TransferOptions = {},
): Promise<OpenedTransfer> {
  const authority = readAuthority(link);
  const origin = apiOrigin();
  abortCheck(options.signal);
  const item = record(
    await readJson(
      await request(
        origin,
        pathFor(authority.id),
        "GET",
        200,
        authority.readToken,
        undefined,
        undefined,
        options.signal,
      ),
      options.signal,
    ),
    ["id", "encryptedManifest", "cipherBytes", "chunkCount", "expiresAt"],
  );
  if (
    item.id !== authority.id ||
    typeof item.encryptedManifest !== "string" ||
    !unixMillis(item.expiresAt) ||
    !Number.isSafeInteger(item.chunkCount) ||
    (item.chunkCount as number) < 1 ||
    (item.chunkCount as number) > maxChunks ||
    !Number.isSafeInteger(item.cipherBytes) ||
    (item.cipherBytes as number) < ENVELOPE_OVERHEAD ||
    (item.cipherBytes as number) > MAX_PLAIN_BYTES + ENVELOPE_OVERHEAD * maxChunks
  )
    throw invalidResponse();
  const envelope = decodeBase64Url(item.encryptedManifest);
  const keys = await deriveKeys(authority.key, authority.id);
  const manifest = await decryptManifest(keys, authority.id, envelope);
  if (
    item.chunkCount !== manifest.chunkCount ||
    item.cipherBytes !== manifest.size + ENVELOPE_OVERHEAD * manifest.chunkCount
  )
    throw invalidResponse();
  abortCheck(options.signal);
  async function receive(
    write: (plaintext: Uint8Array<ArrayBuffer>) => Promise<void>,
    receiveOptions: TransferOptions,
  ): Promise<void> {
    const { signal, onProgress } = receiveOptions;
    let size = 0;
    abortCheck(signal);
    progress(onProgress, { stage: "downloading", done: 0, total: manifest.size });
    for (let index = 0; index < manifest.chunkCount; index++) {
      abortCheck(signal);
      const plainBytes = Math.min(CHUNK_BYTES, manifest.size - index * CHUNK_BYTES);
      const expectedBytes = plainBytes + ENVELOPE_OVERHEAD;
      const response = await request(
        origin,
        `${pathFor(authority.id)}/chunks/${index}`,
        "GET",
        200,
        authority.readToken,
        undefined,
        undefined,
        signal,
      );
      const encrypted = await readBounded(
        response,
        expectedBytes,
        "application/octet-stream",
        signal,
      );
      if (encrypted.length !== expectedBytes) throw invalidResponse();
      const plaintext = await decryptChunk(keys, authority.id, index, encrypted);
      abortCheck(signal);
      if (plaintext.length !== plainBytes) throw invalidResponse();
      // 保存先のbackpressureが解消するまで、次の暗号チャンクを取得しない。
      await write(plaintext);
      abortCheck(signal);
      // write後に保存先がbufferをtransferしても、認証済みの長さで集計する。
      size += plainBytes;
      progress(onProgress, { stage: "downloading", done: size, total: manifest.size });
    }
    abortCheck(signal);
    if (size !== manifest.size) throw invalidResponse();
  }
  return {
    manifest: { ...manifest },
    expiresAt: item.expiresAt,
    download: async (downloadOptions: TransferOptions = {}) => {
      const receiveOptions = { ...options, ...downloadOptions };
      abortCheck(receiveOptions.signal);
      if (manifest.size > MAX_BUFFERED_BYTES)
        throw new Error("100 MBを超えるファイルはストリーミング保存を使用してください。");
      const parts: Uint8Array<ArrayBuffer>[] = [];
      await receive(async (plaintext) => {
        parts.push(plaintext);
      }, receiveOptions);
      abortCheck(receiveOptions.signal);
      return new Blob(parts, { type: manifest.mime });
    },
    downloadTo: async (sink, downloadOptions: TransferOptions = {}) => {
      const receiveOptions = { ...options, ...downloadOptions };
      let writer: WritableStreamDefaultWriter<Uint8Array<ArrayBuffer>> | undefined;
      try {
        writer = sink.getWriter();
        const target = writer;
        await receive((plaintext) => target.write(plaintext), receiveOptions);
        abortCheck(receiveOptions.signal);
        await target.close();
        abortCheck(receiveOptions.signal);
      } catch (error) {
        const failure = receiveOptions.signal?.aborted
          ? new Error("転送を中止しました。")
          : safeTransferError(error);
        // cleanupや保存先の例外で、本来の安全なエラー分類を上書きしない。
        await writer?.abort(failure).catch(() => undefined);
        throw failure;
      } finally {
        writer?.releaseLock();
      }
    },
  };
}

export async function getManagement(link: ManageLink): Promise<ManageRecord> {
  const authority = manageAuthority(link);
  const item = record(
    await readJson(
      await request(
        apiOrigin(),
        `${pathFor(authority.id)}/manage`,
        "GET",
        200,
        authority.manageToken,
      ),
    ),
    ["id", "state", "chunkCount", "uploadedChunks", "expiresAt"],
  );
  if (
    item.id !== authority.id ||
    !["uploading", "ready", "revoked"].includes(item.state as string) ||
    !unixMillis(item.expiresAt) ||
    !Number.isSafeInteger(item.chunkCount) ||
    (item.chunkCount as number) < 1 ||
    (item.chunkCount as number) > maxChunks ||
    !Number.isSafeInteger(item.uploadedChunks) ||
    (item.uploadedChunks as number) < 0 ||
    (item.uploadedChunks as number) > (item.chunkCount as number) ||
    (item.state === "ready" && item.uploadedChunks !== item.chunkCount)
  )
    throw invalidResponse();
  return {
    id: authority.id,
    state: item.state as ManageRecord["state"],
    chunkCount: item.chunkCount as number,
    uploadedChunks: item.uploadedChunks as number,
    expiresAt: item.expiresAt,
  };
}
export async function revokeTransfer(link: ManageLink): Promise<void> {
  const authority = manageAuthority(link);
  await request(apiOrigin(), pathFor(authority.id), "DELETE", 204, authority.manageToken);
}
