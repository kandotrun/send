import { once } from "node:events";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  decodeBase64Url,
  decryptChunk,
  decryptManifest,
  deriveKeys,
  hashSecret,
} from "../src/client/crypto";
import {
  createTransfer,
  getManagement,
  openTransfer,
  parseManageLink,
  parseReadLink,
  revokeTransfer,
} from "../src/client/transfer";
import {
  CHUNK_BYTES,
  type CreateRequest,
  MAX_PLAIN_BYTES,
  type TransferInput,
  type TransferRecord,
} from "../src/shared/protocol";

type Captured = { method: string; path: string; headers: IncomingHttpHeaders; body: Buffer };
const input = (
  blob = new Blob(["秘密の平文 <script>alert(1)</script>"]),
  kind: "text" | "file" = "text",
): TransferInput => ({ blob, kind, name: "private-name.txt", mime: "text/plain" });
const synthetic = (size: number): Uint8Array<ArrayBuffer> =>
  Uint8Array.from({ length: size }, (_, i) => (i * 17 + 5) % 251);

// モックfetchではなく、実際のTCP/HTTP経路からヘッダーと本文を検証する。
class Loopback {
  server: Server;
  origin = "";
  requests: Captured[] = [];
  stored?: CreateRequest;
  chunks = new Map<number, Buffer>();
  ready = false;
  revoked = false;
  failPut = false;
  failComplete = false;
  failCreateStatus?: number;
  failPutStatus?: number;
  failDeleteStatus?: number;
  dropCreate = false;
  dropPut = false;
  dropDelete = false;
  malformedCreate = false;
  badRecord: ((record: TransferRecord) => unknown) | undefined;
  truncate = false;
  corrupt = false;
  swap = false;
  redirect = false;
  oversized = false;
  invalidManage = false;
  holdChunk = false;
  observedChunk?: () => void;

  constructor() {
    this.server = createServer(async (req, res) => {
      try {
        const buffers: Buffer[] = [];
        for await (const part of req) buffers.push(Buffer.from(part));
        const captured = {
          method: req.method ?? "",
          path: req.url ?? "",
          headers: req.headers,
          body: Buffer.concat(buffers),
        };
        this.requests.push(captured);
        const json = (status: number, value: unknown) => {
          res.writeHead(status, {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
          });
          res.end(JSON.stringify(value));
        };
        if (captured.method === "POST" && captured.path === "/api/transfers") {
          this.stored = JSON.parse(captured.body.toString()) as CreateRequest;
          if (this.dropCreate) {
            req.socket.destroy();
            return;
          }
          if (this.failCreateStatus) {
            json(this.failCreateStatus, {
              error: "private-name.txt https://send.example/#r=server-secret",
            });
            return;
          }
          if (this.malformedCreate) {
            res.writeHead(201, { "Content-Type": "application/json" });
            res.end("{broken");
            return;
          }
          json(201, { id: this.stored.id, expiresAt: this.expiresAt() });
          return;
        }
        const stored = this.stored;
        if (!stored) {
          json(404, { error: "not found" });
          return;
        }
        const prefix = `/api/transfers/${stored.id}`;
        const token = captured.headers.authorization?.slice("Bearer ".length) ?? "";
        const manage = captured.method !== "GET" || captured.path.endsWith("/manage");
        if (
          (await hashSecret(token)) !== (manage ? stored.manageTokenHash : stored.readTokenHash)
        ) {
          json(404, { error: "not found" });
          return;
        }
        if (captured.method === "DELETE" && captured.path === prefix) {
          if (this.dropDelete) {
            req.socket.destroy();
            return;
          }
          if (this.failDeleteStatus) {
            json(this.failDeleteStatus, {
              error: `cleanup-secret ${captured.headers.authorization}`,
            });
            return;
          }
          this.revoked = true;
          res.writeHead(204);
          res.end();
          return;
        }
        if (captured.method === "GET" && captured.path === `${prefix}/manage`) {
          json(
            200,
            this.invalidManage
              ? {
                  id: stored.id,
                  state: "ready",
                  uploadedChunks: 999,
                  chunkCount: 1,
                  expiresAt: this.expiresAt(),
                }
              : {
                  id: stored.id,
                  state: this.revoked ? "revoked" : this.ready ? "ready" : "uploading",
                  uploadedChunks: this.chunks.size,
                  chunkCount: stored.chunkCount,
                  expiresAt: this.expiresAt(),
                },
          );
          return;
        }
        if (this.revoked) {
          json(404, { error: "not found" });
          return;
        }
        if (captured.method === "POST" && captured.path === `${prefix}/complete`) {
          if (this.failComplete) {
            json(409, { error: "synthetic failure" });
            return;
          }
          this.ready = true;
          json(200, { id: stored.id, expiresAt: this.expiresAt() });
          return;
        }
        if (captured.path.startsWith(`${prefix}/chunks/`)) {
          const index = Number(captured.path.split("/").at(-1));
          if (captured.method === "PUT") {
            if (this.dropPut) {
              req.socket.destroy();
              return;
            }
            if (this.failPutStatus) {
              json(this.failPutStatus, {
                error: `private-name.txt ${captured.headers.authorization}`,
              });
              return;
            }
            if (this.failPut || this.chunks.has(index)) {
              json(409, { error: "duplicate" });
              return;
            }
            this.chunks.set(index, captured.body);
            res.writeHead(201);
            res.end();
            return;
          }
          if (this.redirect) {
            res.writeHead(302, { Location: `${this.origin}/leak` });
            res.end();
            return;
          }
          if (this.holdChunk) {
            this.observedChunk?.();
            req.socket.once("close", () => res.destroy());
            return;
          }
          let body = this.chunks.get(this.swap ? 1 - index : index) ?? Buffer.alloc(0);
          if (this.truncate) body = body.subarray(0, -1);
          if (this.corrupt) {
            body = Buffer.from(body);
            body[12] = (body[12] ?? 0) ^ 1;
          }
          if (this.oversized) body = Buffer.alloc(CHUNK_BYTES + 29);
          res.writeHead(200, { "Content-Type": "application/octet-stream" });
          res.end(body);
          return;
        }
        if (captured.method === "GET" && captured.path === prefix) {
          const record: TransferRecord = {
            id: stored.id,
            encryptedManifest: stored.encryptedManifest,
            cipherBytes: stored.cipherBytes,
            chunkCount: stored.chunkCount,
            expiresAt: this.expiresAt(),
          };
          if (this.badRecord) {
            const bad = this.badRecord(record);
            if (typeof bad === "string") {
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(bad);
            } else json(200, bad);
          } else json(200, record);
          return;
        }
        json(404, { error: "not found" });
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end('{"error":"invalid request"}');
      }
    });
  }
  expiresAt() {
    return 2_000_000_000_000;
  }
  async start() {
    this.server.listen(0, "127.0.0.1");
    await once(this.server, "listening");
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("loopback address missing");
    this.origin = `http://127.0.0.1:${address.port}`;
  }
  async stop() {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

let loop: Loopback;
beforeEach(async () => {
  loop = new Loopback();
  await loop.start();
  vi.stubGlobal("window", { location: { origin: loop.origin } });
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await loop.stop();
});

describe("send v1 real HTTP client", () => {
  // 本物のHTTP失敗を、cleanupの失敗やサーバーの秘密入り本文に上書きさせない。
  it.each([
    ["create", 503, "uploads-disabled", 429],
    ["create", 429, "rate-limit", 503],
    ["put", 401, "unavailable", undefined],
    ["put", 403, "unavailable", undefined],
    ["put", 404, "unavailable", 429],
    ["put", 410, "unavailable", undefined],
    ["put", 429, "rate-limit", undefined],
    ["put", 413, "too-large", undefined],
    ["put", 409, "conflict", undefined],
    ["put", 503, "unknown", undefined],
  ] as const)(
    "preserves the trusted %s HTTP %i category %s after cleanup",
    async (stage, status, code, cleanupStatus) => {
      if (stage === "create") loop.failCreateStatus = status;
      else loop.failPutStatus = status;
      loop.failDeleteStatus = cleanupStatus;
      const failure = await createTransfer(input(), 3600).catch((error: unknown) => error);
      expect(failure).toMatchObject({ code });
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).not.toMatch(
        /private-name|server-secret|cleanup-secret|https:|Bearer/,
      );
      expect((failure as Error).cause).toBeUndefined();
      expect(loop.requests.at(-1)?.method).toBe("DELETE");
      expect(loop.revoked).toBe(cleanupStatus === undefined);
      expect(loop.ready).toBe(false);
      const token = loop.requests.at(-1)?.headers.authorization?.slice("Bearer ".length);
      expect(token).toBeTruthy();
      expect((failure as Error).message).not.toContain(token);
    },
  );

  it.each(["create", "put"] as const)(
    "preserves network classification for a dropped %s connection after cleanup",
    async (stage) => {
      if (stage === "create") loop.dropCreate = true;
      else loop.dropPut = true;
      const failure = await createTransfer(input(), 3600).catch((error: unknown) => error);
      expect(failure).toMatchObject({
        code: "network",
        message: "通信に失敗しました。接続を確認してください。",
      });
      expect((failure as Error).cause).toBeUndefined();
      expect(loop.requests.at(-1)?.method).toBe("DELETE");
      expect(loop.revoked).toBe(true);
      expect(loop.ready).toBe(false);
    },
  );

  it("preserves rate-limit classification when the cleanup connection is also dropped", async () => {
    loop.failCreateStatus = 429;
    loop.dropDelete = true;
    const failure = await createTransfer(input(), 3600).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "rate-limit" });
    expect(loop.requests.at(-1)?.method).toBe("DELETE");
    expect(loop.revoked).toBe(false);
  });

  it("uploads bounded chunks with only encrypted metadata and capability hashes on the wire", async () => {
    const bytes = synthetic(CHUNK_BYTES + 7);
    const progress: string[] = [];
    const result = await createTransfer(input(new Blob([bytes]), "file"), 3600, {
      onProgress: ({ stage, done, total }) => progress.push(`${stage}:${done}/${total}`),
    });
    const read = parseReadLink(result.readUrl);
    const manage = parseManageLink(result.manageUrl);
    expect(result.id).toBe(read.id);
    expect(loop.ready).toBe(true);
    expect(loop.requests.map((r) => r.method)).toEqual(["POST", "PUT", "PUT", "POST"]);
    const request = loop.stored;
    if (!request) throw new Error("HTTP fixture did not persist the request");
    expect(Object.keys(request).sort()).toEqual([
      "chunkCount",
      "cipherBytes",
      "encryptedManifest",
      "id",
      "manageTokenHash",
      "readTokenHash",
      "ttlSeconds",
    ]);
    expect(request.chunkCount).toBe(2);
    expect(request.cipherBytes).toBe(bytes.length + 56);
    expect(request.readTokenHash).toBe(await hashSecret(read.readToken));
    expect(request.manageTokenHash).toBe(await hashSecret(manage.manageToken));
    expect(loop.chunks.get(0)?.length).toBe(CHUNK_BYTES + 28);
    expect(loop.chunks.get(1)?.length).toBe(35);
    for (const req of loop.requests) {
      expect(req.headers.origin).toBe(loop.origin);
      const captured = `${req.path}\n${JSON.stringify(req.headers)}\n${req.body.toString()}`;
      expect(captured).not.toContain(read.key);
      expect(captured).not.toContain("private-name.txt");
      expect(captured).not.toContain("秘密の平文");
    }
    expect(loop.requests[0]?.headers.authorization).toBeUndefined();
    expect(loop.requests[1]?.headers.authorization).toBe(`Bearer ${manage.manageToken}`);
    expect(loop.requests[3]?.body.toString()).toBe("{}");
    const keys = await deriveKeys(read.key, read.id);
    const manifest = await decryptManifest(
      keys,
      read.id,
      decodeBase64Url(request.encryptedManifest),
    );
    expect(manifest.name).toBe("private-name.txt");
    const lastChunk = loop.chunks.get(1);
    if (!lastChunk) throw new Error("HTTP fixture did not receive the final chunk");
    expect([...(await decryptChunk(keys, read.id, 1, lastChunk))]).toEqual([
      ...bytes.slice(CHUNK_BYTES),
    ]);
    expect(progress).toContain(`uploading:${bytes.length}/${bytes.length}`);
  });

  it("opens only verified metadata then lazily downloads authenticated content", async () => {
    const data = synthetic(CHUNK_BYTES + 11);
    const created = await createTransfer(input(new Blob([data]), "file"), 86400);
    const read = parseReadLink(created.readUrl);
    const before = loop.requests.length;
    const opened = await openTransfer(read);
    expect(loop.requests.slice(before).map((r) => r.path)).toEqual([`/api/transfers/${read.id}`]);
    expect(opened.manifest.size).toBe(data.length);
    const blob = await opened.download();
    expect(blob.type).toBe("text/plain");
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(data);
    for (const req of loop.requests.slice(before)) {
      expect(req.headers.authorization).toBe(`Bearer ${read.readToken}`);
      expect(`${req.path}${JSON.stringify(req.headers)}${req.body}`).not.toContain(read.key);
    }
  });

  it("transfers empty files as one authenticated 28-byte chunk", async () => {
    const created = await createTransfer(input(new Blob([]), "file"), 604800);
    expect(loop.stored?.chunkCount).toBe(1);
    expect(loop.stored?.cipherBytes).toBe(28);
    const opened = await openTransfer(parseReadLink(created.readUrl));
    expect((await opened.download()).size).toBe(0);
  });

  it("returns text as an inert Blob rather than automatically rendering HTML", async () => {
    const created = await createTransfer(input(), 3600);
    const opened = await openTransfer(parseReadLink(created.readUrl));
    expect(opened.manifest.kind).toBe("text");
    expect(await (await opened.download()).text()).toBe("秘密の平文 <script>alert(1)</script>");
  });

  it("uses no-store, redirect rejection and omit credentials for every fetch", async () => {
    const realFetch = globalThis.fetch;
    const options: RequestInit[] = [];
    vi.stubGlobal("fetch", (url: RequestInfo | URL, init?: RequestInit) => {
      options.push(init ?? {});
      return realFetch(url, init);
    });
    const created = await createTransfer(input(), 3600);
    const manage = parseManageLink(created.manageUrl);
    await getManagement(manage);
    await (await openTransfer(parseReadLink(created.readUrl))).download();
    await revokeTransfer(manage);
    expect(options.length).toBe(7);
    for (const option of options) {
      expect(option.cache).toBe("no-store");
      expect(option.redirect).toBe("error");
      expect(option.credentials).toBe("omit");
    }
  });

  it("performs management reads and explicit revoke using only manage authority", async () => {
    const created = await createTransfer(input(), 3600);
    const manage = parseManageLink(created.manageUrl);
    expect((await getManagement(manage)).state).toBe("ready");
    await revokeTransfer(manage);
    expect(loop.revoked).toBe(true);
    expect((await getManagement(manage)).state).toBe("revoked");
    const lastDelete = loop.requests.find((r) => r.method === "DELETE");
    expect(lastDelete?.headers.authorization).toBe(`Bearer ${manage.manageToken}`);
    expect(lastDelete?.headers.origin).toBe(loop.origin);
    await expect(openTransfer(parseReadLink(created.readUrl))).rejects.toThrow(
      /見つかりません|期限|削除/,
    );
  });

  it("rejects invalid inputs before any request", async () => {
    const tooLarge = new Blob([new Uint8Array(MAX_PLAIN_BYTES + 1)]);
    for (const [value, ttl] of [
      [input(tooLarge), 3600],
      [input(), 60],
      [{ ...input(), name: "x".repeat(256) }, 3600],
      [{ ...input(), kind: "html" }, 3600],
    ] as const) {
      await expect(createTransfer(value as TransferInput, ttl as 3600)).rejects.toThrow();
    }
    expect(loop.requests).toHaveLength(0);
  });

  it("reports the 100 MB limit and allowed TTLs before any request", async () => {
    await expect(
      createTransfer(input(new Blob([new Uint8Array(MAX_PLAIN_BYTES + 1)])), 3600),
    ).rejects.toThrow(/100 MB/);
    await expect(createTransfer(input(), 60 as 3600)).rejects.toThrow(/有効期限/);
    expect(loop.requests).toHaveLength(0);
  });

  it("cancels before creation without sending requests", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(createTransfer(input(), 3600, { signal: controller.signal })).rejects.toThrow(
      /中止/,
    );
    expect(loop.requests).toHaveLength(0);
  });

  it("revokes partial uploads after cancellation and never returns a completed link", async () => {
    const controller = new AbortController();
    await expect(
      createTransfer(input(new Blob([synthetic(CHUNK_BYTES + 1)])), 3600, {
        signal: controller.signal,
        onProgress: ({ stage, done }) => {
          if (stage === "uploading" && done > 0) controller.abort();
        },
      }),
    ).rejects.toThrow(/中止/);
    expect(loop.revoked).toBe(true);
    expect(loop.ready).toBe(false);
    expect(loop.chunks.size).toBe(1);
    expect(loop.requests.at(-1)?.method).toBe("DELETE");
  });

  it("does not echo callback errors containing sensitive link data", async () => {
    const sensitive = "送信失敗 https://send.example/#r=private-capability";
    const failure = await createTransfer(input(), 3600, {
      onProgress: () => {
        throw new Error(sensitive);
      },
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      code: "unknown",
      message: "転送を処理できませんでした。もう一度お試しください。",
    });
    expect((failure as Error).message).not.toContain(sensitive);
    expect((failure as Error).cause).toBeUndefined();
    expect(loop.revoked).toBe(true);
  });

  it("revokes failed completion without silently retrying writes", async () => {
    loop.failComplete = true;
    await expect(createTransfer(input(), 3600)).rejects.toThrow();
    expect(loop.revoked).toBe(true);
    expect(loop.requests.filter((r) => r.path.endsWith("/complete"))).toHaveLength(1);
    expect(loop.ready).toBe(false);
  });

  it("does not resend failed or duplicate chunk uploads", async () => {
    loop.failPut = true;
    await expect(createTransfer(input(), 3600)).rejects.toThrow();
    expect(loop.requests.filter((r) => r.method === "PUT")).toHaveLength(1);
    expect(loop.revoked).toBe(true);
  });

  it("cleans up when create responds with malformed JSON after persistence", async () => {
    loop.malformedCreate = true;
    await expect(createTransfer(input(), 3600)).rejects.toThrow();
    expect(loop.revoked).toBe(true);
    expect(loop.requests.map((r) => r.method)).toEqual(["POST", "DELETE"]);
  });

  it.each(["truncate", "corrupt", "swap", "oversized"] as const)(
    "rejects %s chunks before successful assembly",
    async (mode) => {
      const created = await createTransfer(input(new Blob([synthetic(CHUNK_BYTES + 5)])), 3600);
      const opened = await openTransfer(parseReadLink(created.readUrl));
      loop[mode] = true;
      await expect(opened.download()).rejects.toThrow();
    },
  );

  it("aborts in-flight download without deleting the sender transfer", async () => {
    const created = await createTransfer(input(), 3600);
    const opened = await openTransfer(parseReadLink(created.readUrl));
    loop.holdChunk = true;
    const controller = new AbortController();
    const observed = new Promise<void>((resolve) => {
      loop.observedChunk = resolve;
    });
    const download = opened.download({ signal: controller.signal });
    const rejected = expect(download).rejects.toThrow(/中止/);
    await observed;
    controller.abort();
    await rejected;
    expect(loop.revoked).toBe(false);
  });

  it("sanitizes download progress failures without revoking sender authority", async () => {
    const created = await createTransfer(input(), 3600);
    const opened = await openTransfer(parseReadLink(created.readUrl));
    const failed = await opened
      .download({
        onProgress: () => {
          throw new Error(created.readUrl);
        },
      })
      .catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(Error);
    expect((failed as Error).message).not.toContain(created.readUrl);
    expect((failed as Error).message).toMatch(/進捗/);
    expect(loop.revoked).toBe(false);
  });

  it("rejects redirect responses without following or leaking authority", async () => {
    const created = await createTransfer(input(), 3600);
    const opened = await openTransfer(parseReadLink(created.readUrl));
    loop.redirect = true;
    await expect(opened.download()).rejects.toThrow();
    expect(loop.requests.some((r) => r.path === "/leak")).toBe(false);
  });

  it.each([
    (_record: TransferRecord) => "{bad json",
    (record: TransferRecord) => ({ ...record, id: "AAECAwQFBgcICQoLDA0ODw" }),
    (record: TransferRecord) => ({ ...record, cipherBytes: record.cipherBytes + 1 }),
    (record: TransferRecord) => ({ ...record, chunkCount: 2 }),
    (record: TransferRecord) => ({ ...record, expiresAt: "tomorrow" }),
    (record: TransferRecord) => ({ ...record, encryptedManifest: `${record.encryptedManifest}=` }),
    (record: TransferRecord) => ({ ...record, extra: true }),
    (_record: TransferRecord) => " ".repeat(20000),
  ])("rejects malformed or inconsistent metadata before fetching chunks %#", async (badRecord) => {
    const created = await createTransfer(input(), 3600);
    loop.badRecord = badRecord;
    const count = loop.requests.length;
    await expect(openTransfer(parseReadLink(created.readUrl))).rejects.toThrow();
    expect(loop.requests.slice(count).every((r) => !r.path.includes("/chunks/"))).toBe(true);
  });

  it("keeps download binding immutable when callers mutate returned manifest/link objects", async () => {
    const created = await createTransfer(input(), 3600);
    const read = parseReadLink(created.readUrl);
    const opened = await openTransfer(read);
    opened.manifest.size = 0;
    opened.manifest.chunkCount = 0;
    read.id = "AAECAwQFBgcICQoLDA0ODw";
    read.readToken = read.key;
    expect(await (await opened.download()).text()).toBe("秘密の平文 <script>alert(1)</script>");
  });

  it("rejects invalid management records", async () => {
    const created = await createTransfer(input(), 3600);
    loop.invalidManage = true;
    await expect(getManagement(parseManageLink(created.manageUrl))).rejects.toThrow();
  });

  it("rejects foreign/query/credential-bearing links and malformed capabilities before requests", async () => {
    const created = await createTransfer(input(), 3600);
    const count = loop.requests.length;
    expect(() =>
      parseReadLink(created.readUrl.replace(loop.origin, "https://foreign.example")),
    ).toThrow();
    expect(() =>
      parseManageLink(created.manageUrl.replace(loop.origin, "https://foreign.example")),
    ).toThrow();
    expect(() => parseReadLink(created.readUrl.replace("/#", "/?key=x#"))).toThrow();
    expect(() => parseReadLink(created.readUrl.replace("http://", "http://name:pass@"))).toThrow();
    await expect(openTransfer({ ...parseReadLink(created.readUrl), key: "AA" })).rejects.toThrow();
    await expect(
      getManagement({ ...parseManageLink(created.manageUrl), id: "../foreign" }),
    ).rejects.toThrow();
    await expect(
      revokeTransfer({ ...parseManageLink(created.manageUrl), manageToken: "AA" }),
    ).rejects.toThrow();
    expect(loop.requests).toHaveLength(count);
  });
});
