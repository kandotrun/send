import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { setTimeout } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deriveKeys,
  encodeBase64Url,
  encryptChunk,
  encryptManifest,
  generateSecrets,
  type TransferKeys,
} from "../src/client/crypto";
import { invalidResponse, readBounded } from "../src/client/http";
import { openTransfer } from "../src/client/transfer";
import { TransferError, transferErrorCode } from "../src/shared/errors";
import {
  CHUNK_BYTES,
  ENVELOPE_OVERHEAD,
  MAX_BUFFERED_BYTES,
  MAX_PLAIN_BYTES,
  type Manifest,
  type Progress,
} from "../src/shared/protocol";
import { failureDetail } from "../src/web/failure";
import { saveFailureCode, saveFailureDetail, saveLargeFile } from "../src/web/save";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

type Damage = "corrupt" | "truncate" | "wrong-index" | "wrong-length" | "oversized";

// 実HTTP・実AES-GCMで1チャンクずつ生成する。10GBのfixtureもメモリに展開しない。
class StreamingServer {
  readonly secrets = generateSecrets();
  readonly chunkRequests: number[] = [];
  readonly requestMethods: string[] = [];
  readonly server: Server;
  keys!: TransferKeys;
  manifest!: Manifest;
  encryptedManifest = "";
  origin = "";
  damage?: Damage;
  damageIndex = 0;
  chunkStatus?: number;
  dropChunk = false;
  holdChunk = false;
  observedChunk?: () => void;

  constructor() {
    this.server = createServer(async (req, res) => {
      try {
        this.requestMethods.push(req.method ?? "");
        if (req.headers.authorization !== `Bearer ${this.secrets.readToken}`) {
          res.writeHead(404);
          res.end();
          return;
        }
        expect(req.url).not.toContain(this.secrets.key);
        const prefix = `/api/transfers/${this.secrets.id}`;
        if (req.url === prefix) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              id: this.secrets.id,
              encryptedManifest: this.encryptedManifest,
              chunkCount: this.manifest.chunkCount,
              cipherBytes: this.manifest.size + ENVELOPE_OVERHEAD * this.manifest.chunkCount,
              expiresAt: 2_000_000_000_000,
            }),
          );
          return;
        }
        const index = Number(req.url?.slice(`${prefix}/chunks/`.length));
        this.chunkRequests.push(index);
        this.observedChunk?.();
        if (this.holdChunk) return;
        if (this.dropChunk) {
          req.socket.destroy();
          return;
        }
        if (this.chunkStatus) {
          res.writeHead(this.chunkStatus, { "Content-Type": "application/json" });
          res.end('{"error":"https://send.example/#r=private-server-secret"}');
          return;
        }
        const damage = index === this.damageIndex ? this.damage : undefined;
        const expected = this.plaintext(index);
        let encrypted = await encryptChunk(
          this.keys,
          this.secrets.id,
          damage === "wrong-index" ? index + 1 : index,
          damage === "wrong-length" ? expected.slice(0, -1) : expected,
        );
        if (damage === "corrupt") {
          const last = encrypted.length - 1;
          encrypted[last] = (encrypted[last] ?? 0) ^ 1;
        }
        if (damage === "truncate") encrypted = encrypted.slice(0, -1);
        if (damage === "oversized") encrypted = new Uint8Array(encrypted.length + 1);
        res.writeHead(200, { "Content-Type": "application/octet-stream" });
        res.end(encrypted);
      } catch {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      }
    });
  }

  plaintext(index: number): Uint8Array<ArrayBuffer> {
    const bytes = new Uint8Array(
      Math.min(CHUNK_BYTES, this.manifest.size - index * CHUNK_BYTES),
    ).fill((index + 1) % 251);
    if (bytes.length) bytes[bytes.length - 1] = (index + 117) % 251;
    return bytes;
  }

  async prepare(size = CHUNK_BYTES + 7) {
    this.keys = await deriveKeys(this.secrets.key, this.secrets.id);
    this.manifest = {
      version: 1,
      id: this.secrets.id,
      kind: "file",
      name: "synthetic-stream.bin",
      mime: "application/octet-stream",
      size,
      chunkCount: Math.max(1, Math.ceil(size / CHUNK_BYTES)),
      chunkBytes: CHUNK_BYTES,
      ttlSeconds: 3600,
    };
    this.encryptedManifest = encodeBase64Url(await encryptManifest(this.keys, this.manifest));
  }

  async start() {
    this.server.listen(0, "127.0.0.1");
    await once(this.server, "listening");
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("Loopback address missing");
    this.origin = `http://127.0.0.1:${address.port}`;
  }

  async stop() {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

let loop: StreamingServer;
beforeEach(async () => {
  loop = new StreamingServer();
  await loop.start();
  vi.stubGlobal("window", { location: { origin: loop.origin } });
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await loop.stop();
});

const open = () => openTransfer(loop.secrets);
const privateFailure = new Error("https://send.example/#r=private-sink-secret");
const privateBodyFailure = new TypeError("https://send.example/#r=private-body-secret", {
  cause: new Error("private-response-cause"),
});

// 暗号・metadata・HTTPは実装を通す。最初の本文だけを途中で切れるtransportに置き換える。
function interruptChunkBody(onFailure?: () => void) {
  const realFetch = globalThis.fetch;
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (...args) => {
    const response = await realFetch(...args);
    if (!String(args[0]).includes("/chunks/")) return response;
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Synthetic chunk response has no body");
    let delivered = false;
    const body = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          if (!delivered) {
            const part = await reader.read();
            if (part.done) throw new Error("Synthetic chunk response is empty");
            controller.enqueue(part.value);
            delivered = true;
            return;
          }
          onFailure?.();
          controller.error(privateBodyFailure);
          await reader.cancel().catch(() => undefined);
          reader.releaseLock();
        },
      },
      { highWaterMark: 0 },
    );
    return new Response(body, { status: response.status, headers: response.headers });
  });
}

function countingSink(
  callback?: (bytes: Uint8Array<ArrayBuffer>) => void | Promise<void>,
  onAbort?: (reason: unknown) => void | Promise<void>,
) {
  const writes: number[] = [];
  let closed = false;
  const aborts: unknown[] = [];
  const sink = new WritableStream<Uint8Array<ArrayBuffer>>({
    async write(bytes) {
      writes.push(bytes.length);
      await callback?.(bytes);
    },
    close() {
      closed = true;
    },
    async abort(reason) {
      aborts.push(reason);
      await onAbort?.(reason);
    },
  });
  return {
    sink,
    writes,
    aborts,
    get closed() {
      return closed;
    },
  };
}

describe("bounded authenticated receive over real HTTP", () => {
  it("counts authenticated bytes before a sink transfers ownership of their buffer", async () => {
    await loop.prepare(7);
    const opened = await open();
    let received = 0;
    const target = countingSink((bytes) => {
      const consumed = structuredClone(bytes, { transfer: [bytes.buffer] });
      received += consumed.length;
      expect(bytes.length).toBe(0);
    });
    await opened.downloadTo(target.sink);
    expect(received).toBe(7);
    expect(target.closed).toBe(true);
    expect(target.sink.locked).toBe(false);
  });

  it.each([MAX_BUFFERED_BYTES + 1, MAX_PLAIN_BYTES])(
    "refuses buffered download of %i bytes before fetching chunks or constructing Blob",
    async (size) => {
      await loop.prepare(size);
      // 前の実装でも巨大受信を走らせない。最初のGETだけで即失敗させる。
      loop.chunkStatus = 503;
      const opened = await open();
      const blob = vi.spyOn(globalThis, "Blob");
      await expect(opened.download()).rejects.toThrow(/100 MB/);
      expect(loop.chunkRequests).toEqual([]);
      expect(blob).not.toHaveBeenCalled();
    },
  );

  it.each([0, 1, CHUNK_BYTES, CHUNK_BYTES + 13, 2 * CHUNK_BYTES])(
    "streams exactly %i authenticated bytes with the correct final chunk and closes only after validation",
    async (size) => {
      await loop.prepare(size);
      const opened = await open();
      let total = 0;
      let index = 0;
      const lengths: number[] = [];
      const progress: Progress[] = [];
      const target = countingSink((bytes) => {
        expect(bytes).toBeInstanceOf(Uint8Array);
        expect(bytes.length).toBeLessThanOrEqual(CHUNK_BYTES);
        expect(Buffer.from(bytes).equals(Buffer.from(loop.plaintext(index)))).toBe(true);
        lengths.push(bytes.length);
        total += bytes.length;
        index++;
      });
      await opened.downloadTo(target.sink, { onProgress: (value) => progress.push(value) });
      expect(total).toBe(size);
      expect(index).toBe(loop.manifest.chunkCount);
      expect(lengths.at(-1)).toBe(size === 0 ? 0 : ((size - 1) % CHUNK_BYTES) + 1);
      expect(loop.chunkRequests).toEqual(Array.from({ length: index }, (_, i) => i));
      expect(progress.at(-1)).toEqual({ stage: "downloading", done: size, total: size });
      expect(target.closed).toBe(true);
      expect(target.aborts).toEqual([]);
      expect(target.sink.locked).toBe(false);
    },
  );

  it("waits for each sink write before requesting the next encrypted chunk", async () => {
    await loop.prepare();
    const opened = await open();
    const entered = deferred<void>();
    const gate = deferred<void>();
    const target = countingSink(async () => {
      if (target.writes.length === 1) {
        entered.resolve();
        await gate.promise;
      }
    });
    const download = opened.downloadTo(target.sink);
    await entered.promise;
    await setTimeout(20);
    expect(loop.chunkRequests).toEqual([0]);
    expect(target.closed).toBe(false);
    gate.resolve();
    await download;
    expect(loop.chunkRequests).toEqual([0, 1]);
    expect(target.writes).toEqual([CHUNK_BYTES, 7]);
  });

  it.each(["corrupt", "truncate", "wrong-index", "wrong-length", "oversized"] as const)(
    "never forwards the first %s chunk to the sink",
    async (damage) => {
      await loop.prepare();
      loop.damage = damage;
      const opened = await open();
      const target = countingSink();
      await expect(opened.downloadTo(target.sink)).rejects.toThrow();
      expect(target.writes).toEqual([]);
      expect(target.closed).toBe(false);
      expect(target.aborts).toHaveLength(1);
      expect(target.sink.locked).toBe(false);
      expect(loop.chunkRequests).toEqual([0]);
      expect(loop.requestMethods).not.toContain("DELETE");
    },
  );

  it("aborts a partially written sink when the final authenticated chunk is corrupt", async () => {
    await loop.prepare();
    loop.damage = "corrupt";
    loop.damageIndex = 1;
    const opened = await open();
    const target = countingSink();
    const failure = await opened.downloadTo(target.sink).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TransferError);
    expect(failure).toMatchObject({ code: "decryption" });
    expect(target.writes).toEqual([CHUNK_BYTES]);
    expect(target.closed).toBe(false);
    expect(target.aborts).toEqual([failure]);
    expect(target.sink.locked).toBe(false);
  });

  it("sanitizes late sink write rejection without fetching another chunk", async () => {
    await loop.prepare(2 * CHUNK_BYTES + 1);
    const opened = await open();
    const target = countingSink(() => {
      if (target.writes.length === 2) throw privateFailure;
    });
    const failure = await opened.downloadTo(target.sink).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "unknown" });
    expect((failure as Error).message).not.toContain(privateFailure.message);
    expect((failure as Error).cause).toBeUndefined();
    expect(target.writes).toEqual([CHUNK_BYTES, CHUNK_BYTES]);
    expect(loop.chunkRequests).toEqual([0, 1]);
    expect(target.closed).toBe(false);
    expect(target.sink.locked).toBe(false);
  });

  it("preserves the original network category even if sink abort rejects", async () => {
    await loop.prepare();
    loop.dropChunk = true;
    const opened = await open();
    const abort = vi.fn(async () => {
      throw privateFailure;
    });
    const sink = new WritableStream<Uint8Array<ArrayBuffer>>({ abort });
    const failure = await opened.downloadTo(sink).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "network" });
    expect(abort).toHaveBeenCalledWith(failure);
    expect((failure as Error).message).not.toContain(privateFailure.message);
    expect(sink.locked).toBe(false);
  });

  it.each(["client", "native-save UI"] as const)(
    "keeps interrupted chunk-body reads as network failures through %s and rejecting cleanup",
    async (surface) => {
      await loop.prepare(MAX_BUFFERED_BYTES + 1);
      const opened = await open();
      interruptChunkBody();
      const target = countingSink(undefined, () => {
        throw privateFailure;
      });
      // 保存先選択だけを代替し、実saveLargeFileと実WritableStreamの所有権を検証する。
      const picker = vi.fn(async () => ({ createWritable: async () => target.sink }));
      const operation =
        surface === "client"
          ? opened.downloadTo(target.sink)
          : saveLargeFile(opened, picker, { isCurrent: () => true });
      const failure = await operation.catch((error: unknown) => error);
      const detail = saveFailureDetail(failure) ?? failureDetail(failure, "receive");
      expect.soft(detail).toBe("通信できませんでした。接続を確認して、もう一度お試しください。");
      expect.soft(transferErrorCode(failure)).toBe("network");
      expect.soft(failure).toBeInstanceOf(TransferError);
      expect((failure as Error).cause).toBeUndefined();
      expect((failure as Error).message).not.toMatch(/private-|https:\/\//);
      expect(saveFailureCode(failure)).toBeUndefined();
      expect(target.writes).toEqual([]);
      expect(target.closed).toBe(false);
      expect(target.aborts).toEqual([failure]);
      if (surface === "native-save UI")
        expect(picker).toHaveBeenCalledExactlyOnceWith({ suggestedName: "synthetic-stream.bin" });
      expect(target.sink.locked).toBe(false);
      expect(loop.chunkRequests).toEqual([0]);
    },
  );

  it.each(["client", "native-save UI"] as const)(
    "gives cancellation priority over a concurrent chunk-body rejection through %s",
    async (surface) => {
      await loop.prepare(MAX_BUFFERED_BYTES + 1);
      const opened = await open();
      const controller = new AbortController();
      interruptChunkBody(() => controller.abort());
      const target = countingSink();
      const operation =
        surface === "client"
          ? opened.downloadTo(target.sink, { signal: controller.signal })
          : saveLargeFile(opened, async () => ({ createWritable: async () => target.sink }), {
              isCurrent: () => true,
              signal: controller.signal,
            });
      const failure = await operation.catch((error: unknown) => error);
      expect(transferErrorCode(failure)).toBeUndefined();
      expect((failure as Error).message).toContain("中止");
      expect((failure as Error).cause).toBeUndefined();
      if (surface === "native-save UI") {
        expect(saveFailureCode(failure)).toBe("cancelled");
        expect(saveFailureDetail(failure)).toBe(
          "保存先の選択または受け取りを中止しました。もう一度ボタンを押すと、はじめから受け取れます。",
        );
      }
      expect(target.writes).toEqual([]);
      expect(target.closed).toBe(false);
      expect(target.aborts).toHaveLength(1);
      expect(target.sink.locked).toBe(false);
      expect(loop.chunkRequests).toEqual([0]);
    },
  );

  it.each([
    ["wrong content type", "text/html", null, 1],
    ["malformed declared length", "application/octet-stream", "private-body-secret", 1],
    ["oversized declared length", "application/octet-stream", "4", 1],
    ["oversized body", "application/octet-stream", null, 4],
    ["mismatched body length", "application/octet-stream", "2", 1],
  ] as const)(
    "keeps %s as invalid response rather than a network failure",
    async (_description, type, declared, size) => {
      const headers = new Headers({ "Content-Type": type });
      if (declared !== null) headers.set("Content-Length", declared);
      const response = new Response(new Uint8Array(size), { headers });
      const failure = await readBounded(response, 3, "application/octet-stream").catch(
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe(invalidResponse().message);
      expect((failure as Error).cause).toBeUndefined();
      expect(transferErrorCode(failure)).toBeUndefined();
    },
  );

  it("checks cancellation at the body-read boundary before branding a transport rejection", async () => {
    const controller = new AbortController();
    const response = new Response(
      new ReadableStream(
        {
          pull(body) {
            controller.abort();
            body.error(privateBodyFailure);
          },
        },
        { highWaterMark: 0 },
      ),
      { headers: { "Content-Type": "application/octet-stream" } },
    );
    const failure = await readBounded(
      response,
      3,
      "application/octet-stream",
      controller.signal,
    ).catch((error: unknown) => error);
    expect((failure as Error).message).toBe("転送を中止しました。");
    expect(transferErrorCode(failure)).toBeUndefined();
    expect((failure as Error).cause).toBeUndefined();
    expect(response.body?.locked).toBe(false);
  });

  it.each([
    [404, "unavailable"],
    [429, "rate-limit"],
    [503, "unknown"],
  ] as const)(
    "preserves HTTP %i category %s and aborts the sink without exposing server details",
    async (status, code) => {
      await loop.prepare();
      loop.chunkStatus = status;
      const opened = await open();
      const target = countingSink();
      const failure = await opened.downloadTo(target.sink).catch((error: unknown) => error);
      expect(failure).toMatchObject({ code });
      expect((failure as Error).message).not.toContain("private-server-secret");
      expect(target.aborts).toEqual([failure]);
      expect(target.writes).toEqual([]);
      expect(target.sink.locked).toBe(false);
    },
  );

  it("cancels before receiving with no chunk request and aborts the sink", async () => {
    await loop.prepare();
    const opened = await open();
    const controller = new AbortController();
    controller.abort();
    const target = countingSink();
    await expect(opened.downloadTo(target.sink, { signal: controller.signal })).rejects.toThrow(
      /中止/,
    );
    expect(loop.chunkRequests).toEqual([]);
    expect(target.aborts).toHaveLength(1);
    expect(target.closed).toBe(false);
    expect(target.sink.locked).toBe(false);
  });

  it("cancels while a sink write is deferred without requesting a later chunk", async () => {
    await loop.prepare();
    const opened = await open();
    const controller = new AbortController();
    const entered = deferred<void>();
    const gate = deferred<void>();
    const target = countingSink(async () => {
      entered.resolve();
      await gate.promise;
    });
    const download = opened.downloadTo(target.sink, { signal: controller.signal });
    const failed = expect(download).rejects.toThrow(/中止/);
    await entered.promise;
    controller.abort();
    await setTimeout(20);
    expect(loop.chunkRequests).toEqual([0]);
    gate.resolve();
    await failed;
    expect(target.writes).toEqual([CHUNK_BYTES]);
    expect(target.closed).toBe(false);
    expect(target.aborts).toHaveLength(1);
    expect(target.sink.locked).toBe(false);
  });

  it("rechecks cancellation after decryption before writing any plaintext", async () => {
    await loop.prepare(7);
    const opened = await open();
    const controller = new AbortController();
    const realDecrypt = crypto.subtle.decrypt.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, "decrypt").mockImplementation(async (...args) => {
      const plaintext = await realDecrypt(...args);
      controller.abort();
      return plaintext;
    });
    const target = countingSink();
    await expect(opened.downloadTo(target.sink, { signal: controller.signal })).rejects.toThrow(
      /中止/,
    );
    expect(target.writes).toEqual([]);
    expect(target.aborts).toHaveLength(1);
    expect(target.closed).toBe(false);
    expect(target.sink.locked).toBe(false);
  });

  it("does not report success if cancellation arrives during sink close", async () => {
    await loop.prepare(7);
    const opened = await open();
    const controller = new AbortController();
    const entered = deferred<void>();
    const gate = deferred<void>();
    const sink = new WritableStream<Uint8Array<ArrayBuffer>>({
      async close() {
        entered.resolve();
        await gate.promise;
      },
    });
    const download = opened.downloadTo(sink, { signal: controller.signal });
    const failed = expect(download).rejects.toThrow(/中止/);
    await entered.promise;
    controller.abort();
    gate.resolve();
    await failed;
    expect(sink.locked).toBe(false);
  });

  it("sanitizes sink close rejection and releases the writer lock", async () => {
    await loop.prepare(7);
    const opened = await open();
    const sink = new WritableStream<Uint8Array<ArrayBuffer>>({
      close() {
        throw privateFailure;
      },
    });
    const failure = await opened.downloadTo(sink).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "unknown" });
    expect((failure as Error).message).not.toContain(privateFailure.message);
    expect(sink.locked).toBe(false);
  });

  it("stops before close when the final progress callback cancels", async () => {
    await loop.prepare(7);
    const opened = await open();
    const controller = new AbortController();
    const target = countingSink();
    await expect(
      opened.downloadTo(target.sink, {
        signal: controller.signal,
        onProgress: ({ done }) => {
          if (done > 0) controller.abort();
        },
      }),
    ).rejects.toThrow(/中止/);
    expect(target.writes).toEqual([7]);
    expect(target.closed).toBe(false);
    expect(target.aborts).toHaveLength(1);
    expect(target.sink.locked).toBe(false);
  });

  it("uses immutable verified manifest and authority snapshots for streaming", async () => {
    await loop.prepare(7);
    const authority = { ...loop.secrets };
    const opened = await openTransfer(authority);
    authority.id = generateSecrets().id;
    authority.readToken = generateSecrets().readToken;
    opened.manifest.size = 0;
    opened.manifest.chunkCount = 0;
    const target = countingSink();
    await opened.downloadTo(target.sink);
    expect(target.writes).toEqual([7]);
    expect(target.closed).toBe(true);
  });
});
