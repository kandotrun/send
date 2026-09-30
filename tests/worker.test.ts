import { createHash, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CHUNK_BYTES, MAX_PLAIN_BYTES } from "../src/shared/protocol";
import { ORIGIN, startWorker } from "./worker/harness";

let runtime: Awaited<ReturnType<typeof startWorker>>;
const hash = (secret: string) =>
  createHash("sha256").update(Buffer.from(secret, "base64url")).digest("base64url");
function fixture(plainBytes = 4) {
  const read = Buffer.from(randomBytes(32)).toString("base64url");
  const manage = Buffer.from(randomBytes(32)).toString("base64url");
  const chunkCount = Math.max(1, Math.ceil(plainBytes / CHUNK_BYTES));
  return {
    read,
    manage,
    payload: {
      id: Buffer.from(randomBytes(16)).toString("base64url"),
      readTokenHash: hash(read),
      manageTokenHash: hash(manage),
      encryptedManifest: Buffer.from(randomBytes(40)).toString("base64url"),
      cipherBytes: plainBytes + 28 * chunkCount,
      chunkCount,
      ttlSeconds: 3600,
    },
  };
}
function request(
  path: string,
  method = "GET",
  body?: string | Uint8Array | ReadableStream,
  token?: string,
  headers: Record<string, string> = {},
) {
  return runtime.mf.dispatchFetch(`${ORIGIN}${path}`, {
    method,
    body,
    duplex: "half",
    headers: {
      "X-Test-Host": headers.Host ?? "send.test",
      "X-Test-IP":
        headers["CF-Connecting-IP"] === ""
          ? "missing"
          : (headers["CF-Connecting-IP"] ?? "192.0.2.1"),
      "CF-Connecting-IP": "192.0.2.1",
      ...(method !== "GET" ? { Origin: ORIGIN } : {}),
      ...(typeof body === "string"
        ? { "Content-Type": "application/json" }
        : body
          ? { "Content-Type": "application/octet-stream" }
          : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
  });
}
async function control(action: string, body?: object) {
  return request(`/__test/${action}`, "POST", body ? JSON.stringify(body) : undefined);
}
async function create(f = fixture()) {
  const response = await request("/api/transfers", "POST", JSON.stringify(f.payload));
  expect(response.status, await response.clone().text()).toBe(201);
  return f;
}
async function upload(f: ReturnType<typeof fixture>, index = 0, value?: Uint8Array) {
  const len =
    index === f.payload.chunkCount - 1
      ? f.payload.cipherBytes - (CHUNK_BYTES + 28) * index
      : CHUNK_BYTES + 28;
  return request(
    `/api/transfers/${f.payload.id}/chunks/${index}`,
    "PUT",
    value ?? new Uint8Array(len).fill(7),
    f.manage,
  );
}
async function complete(f: ReturnType<typeof fixture>) {
  return request(`/api/transfers/${f.payload.id}/complete`, "POST", "{}", f.manage);
}
async function ready() {
  const f = await create();
  expect((await upload(f)).status).toBe(201);
  expect((await complete(f)).status).toBe(200);
  return f;
}
async function snapshot() {
  const tables = ["transfers", "chunks", "rate_limits"];
  return Promise.all(
    tables.map(
      async (table) =>
        (await runtime.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results,
    ),
  );
}
async function reserved() {
  return (
    await runtime.db
      .prepare("SELECT COALESCE(SUM(reserved_bytes),0) AS bytes FROM transfers")
      .first<{ bytes: number }>()
  )?.bytes;
}
async function waitForPut() {
  for (let n = 0; n < 100; n++) {
    const response = await request("/__test/pending");
    if (((await response.json()) as { pending: number }).pending > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("R2 boundary was not reached");
}

describe("send Worker with real D1 and R2", () => {
  beforeEach(async () => {
    runtime = await startWorker();
  }, 60000);
  afterEach(async () => {
    await runtime?.mf.dispose();
  }, 60000);

  it("spec: health advertises the upload safety gate and every response has security headers", async () => {
    const response = await request("/api/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      uploadsEnabled: true,
      maxPlainBytes: MAX_PLAIN_BYTES,
    });
    for (const path of ["/api/health", "/", "/api/unknown"]) {
      const r = await request(path);
      expect(r.headers.get("Cache-Control")).toBe("no-store");
      expect(r.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(r.headers.get("Referrer-Policy")).toBe("no-referrer");
      expect(r.headers.get("X-Frame-Options")).toBe("DENY");
      expect(r.headers.get("Content-Security-Policy")).toContain("script-src 'self'");
      expect(r.headers.get("Access-Control-Allow-Origin")).toBeNull();
    }
  });

  it("spec: creates, uploads, completes, reads and revokes using independent hash-only capabilities", async () => {
    const f = await ready();
    const path = `/api/transfers/${f.payload.id}`;
    const record = await request(path, "GET", undefined, f.read);
    expect(await record.json()).toMatchObject({
      id: f.payload.id,
      encryptedManifest: f.payload.encryptedManifest,
      cipherBytes: 32,
      chunkCount: 1,
    });
    const stored = await runtime.db
      .prepare("SELECT * FROM transfers WHERE id = ?")
      .bind(f.payload.id)
      .first();
    expect(JSON.stringify(stored)).not.toContain(f.read);
    expect(JSON.stringify(stored)).not.toContain(f.manage);
    const chunk = await request(`${path}/chunks/0`, "GET", undefined, f.read);
    expect(chunk.status).toBe(200);
    expect(chunk.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(new Uint8Array(await chunk.arrayBuffer())).toEqual(new Uint8Array(32).fill(7));
    expect((await complete(f)).status).toBe(200);
    expect((await upload(f)).status).toBe(409);
    expect(
      await (await request(`${path}/manage`, "GET", undefined, f.manage)).json(),
    ).toMatchObject({ state: "ready", uploadedChunks: 1 });
    expect((await request(path, "DELETE", undefined, f.manage)).status).toBe(204);
    expect((await request(path, "DELETE", undefined, f.manage)).status).toBe(204);
    expect((await request(path, "GET", undefined, f.read)).status).toBe(404);
    expect((await request(`${path}/chunks/0`, "GET", undefined, f.read)).status).toBe(404);
    await control("cleanup");
    expect((await runtime.bucket.list()).objects).toHaveLength(0);
    expect(await reserved()).toBe(0);
  });

  it("spec: unauthorized operations on seeded storage have no effects and reads have uniform 404s", async () => {
    const f = await ready();
    const path = `/api/transfers/${f.payload.id}`;
    const before = await snapshot();
    const objectBefore = (await runtime.bucket.list()).objects.map((o) => o.key);
    for (const token of [
      undefined,
      Buffer.from(randomBytes(32)).toString("base64url"),
      f.manage,
      `${f.read}=`,
      `${f.read.slice(0, -1)}!`,
    ]) {
      const response = await request(path, "GET", undefined, token);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "not_found" });
      expect((await request(`${path}/chunks/0`, "GET", undefined, token)).status).toBe(404);
    }
    for (const token of [undefined, f.read, Buffer.from(randomBytes(32)).toString("base64url")]) {
      expect((await request(path, "DELETE", undefined, token)).status).toBe(404);
      expect((await request(`${path}/manage`, "GET", undefined, token)).status).toBe(404);
      expect((await request(`${path}/complete`, "POST", "{}", token)).status).toBe(404);
      expect((await request(`${path}/chunks/0`, "PUT", new Uint8Array(32), token)).status).toBe(
        404,
      );
    }
    expect(await snapshot()).toEqual(before);
    expect((await runtime.bucket.list()).objects.map((o) => o.key)).toEqual(objectBefore);
    expect(
      await (
        await request(`/api/transfers/${fixture().payload.id}`, "GET", undefined, f.read)
      ).json(),
    ).toEqual({ error: "not_found" });
  });

  it("spec: host, required Origin, cross-site GET and encoded/query routes fail before writes", async () => {
    const f = await ready();
    const path = `/api/transfers/${f.payload.id}`;
    const before = await snapshot();
    const badHeaders: Record<string, string>[] = [
      { Origin: "" },
      { Origin: "https://evil.test" },
      { Host: "evil.test" },
      { Origin: `${ORIGIN}/` },
    ];
    for (const h of badHeaders) {
      expect((await request(path, "DELETE", undefined, f.manage, h)).status).toBe(403);
      expect(
        (await request("/api/transfers", "POST", JSON.stringify(fixture().payload), undefined, h))
          .status,
      ).toBe(403);
    }
    expect(
      (
        await runtime.mf.dispatchFetch(`https://evil.test${path}`, {
          method: "DELETE",
          headers: {
            "X-Test-Host": "evil.test",
            Origin: ORIGIN,
            Authorization: `Bearer ${f.manage}`,
          },
        })
      ).status,
    ).toBe(403);
    expect(
      (await request(path, "GET", undefined, f.read, { Origin: "https://evil.test" })).status,
    ).toBe(403);
    expect(
      (await request(path, "GET", undefined, f.read, { "Sec-Fetch-Site": "cross-site" })).status,
    ).toBe(403);
    for (const invalid of [
      `${path}?token=bad`,
      `/api/transfers/%${f.payload.id.charCodeAt(0).toString(16)}${f.payload.id.slice(1)}`,
      `${path}/chunks/00`,
      `${path}/chunks/-1`,
      "/api/transfers/short",
    ]) {
      expect((await request(invalid, "DELETE", undefined, f.manage)).status).toBe(404);
    }
    expect(await snapshot()).toEqual(before);
  });

  it("spec: rejects malformed, oversized and inconsistent creates without persistence", async () => {
    const payload = fixture().payload;
    const before = await snapshot();
    for (const patch of [
      { id: `${payload.id.slice(0, -1)}B` },
      { readTokenHash: `${payload.readTokenHash}=` },
      { manageTokenHash: payload.readTokenHash },
      { encryptedManifest: "***" },
      { encryptedManifest: Buffer.from(randomBytes(8193)).toString("base64url") },
      { cipherBytes: -1 },
      { cipherBytes: MAX_PLAIN_BYTES + 28 * 24 + 1, chunkCount: 24 },
      { cipherBytes: 28, chunkCount: 2 },
      { cipherBytes: CHUNK_BYTES + 28 + 1, chunkCount: 1 },
      { chunkCount: 25 },
      { ttlSeconds: 1 },
      { extra: "secret" },
      { cipherBytes: 32.5 },
      { encryptedManifest: "" },
    ])
      expect(
        (await request("/api/transfers", "POST", JSON.stringify({ ...payload, ...patch }))).status,
      ).toBe(400);
    expect((await request("/api/transfers", "POST", "{")).status).toBe(400);
    expect(
      (
        await request("/api/transfers", "POST", JSON.stringify(payload), undefined, {
          "Content-Type": "text/plain",
        })
      ).status,
    ).toBe(415);
    expect(
      (
        await request("/api/transfers", "POST", JSON.stringify(payload), undefined, {
          "Content-Type": "application/json; charset=utf-8;evil=1",
        })
      ).status,
    ).toBe(415);
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array(17000).fill(32));
        c.close();
      },
    });
    expect(
      (
        await request("/api/transfers", "POST", stream, undefined, {
          "Content-Type": "application/json",
        })
      ).status,
    ).toBe(413);
    expect(await snapshot()).toEqual(before);
  });

  it("spec: create fails closed without the feature gate, secret, trusted IP or valid configuration", async () => {
    for (const overrides of [
      { UPLOADS_ENABLED: "false" },
      { RATE_LIMIT_SECRET: "" },
      { GLOBAL_BYTE_CAP: "0" },
      { IP_CREATE_LIMIT: "NaN" },
      { APP_ORIGIN: "http://send.test" },
    ]) {
      await control("config", overrides);
      const response = await request("/api/transfers", "POST", JSON.stringify(fixture().payload));
      expect([403, 503]).toContain(response.status);
    }
    await control("config", {});
    expect(
      (
        await request("/api/transfers", "POST", JSON.stringify(fixture().payload), undefined, {
          "CF-Connecting-IP": "",
        })
      ).status,
    ).toBe(503);
    expect((await runtime.db.prepare("SELECT * FROM transfers").all()).results).toHaveLength(0);
    await control("config", { APP_ORIGIN: "http://localhost:8787" });
    const local = await runtime.mf.dispatchFetch("http://localhost:8787/api/transfers", {
      method: "POST",
      headers: {
        "X-Test-Host": "localhost:8787",
        Origin: "http://localhost:8787",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(fixture().payload),
    });
    expect(local.status).toBe(201);
    const rows = await runtime.db.prepare("SELECT * FROM rate_limits").all();
    expect(JSON.stringify(rows)).not.toContain("192.0.2.1");
    expect(JSON.stringify(rows)).not.toContain("localhost");
  });

  it("spec: accepts an empty transfer, enforces exact bounded chunk streams and complete requires all chunks", async () => {
    const f = await create(fixture(0));
    expect((await complete(f)).status).toBe(409);
    const before = await snapshot();
    for (const size of [0, 27, 29, CHUNK_BYTES + 29]) {
      const stream = new ReadableStream({
        start(c) {
          if (size) c.enqueue(new Uint8Array(size));
          c.close();
        },
      });
      expect([400, 413]).toContain(
        (await request(`/api/transfers/${f.payload.id}/chunks/0`, "PUT", stream, f.manage)).status,
      );
    }
    expect(
      (
        await request(
          `/api/transfers/${f.payload.id}/chunks/1`,
          "PUT",
          new Uint8Array(28),
          f.manage,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await request(
          `/api/transfers/${f.payload.id}/chunks/0`,
          "PUT",
          new Uint8Array(28),
          f.manage,
          { "Content-Type": "text/plain" },
        )
      ).status,
    ).toBe(415);
    expect(
      (
        await request(
          `/api/transfers/${f.payload.id}/complete`,
          "POST",
          '{"unexpected":1}',
          f.manage,
        )
      ).status,
    ).toBe(400);
    expect(await snapshot()).toEqual(before);
    expect((await upload(f)).status).toBe(201);
    expect((await complete(f)).status).toBe(200);
    const multi = await create(fixture(CHUNK_BYTES + 1));
    expect((await upload(multi, 0)).status).toBe(201);
    expect((await complete(multi)).status).toBe(409);
    expect((await upload(multi, 1)).status).toBe(201);
    expect((await complete(multi)).status).toBe(200);
  });

  it("spec: pending deadlines and expiry block reads, puts and completion", async () => {
    const f = await create();
    await runtime.db
      .prepare("UPDATE transfers SET upload_deadline = ? WHERE id = ?")
      .bind(Date.now() - 1, f.payload.id)
      .run();
    expect((await upload(f)).status).toBe(404);
    expect((await complete(f)).status).toBe(404);
    const r = await ready();
    await runtime.db
      .prepare("UPDATE transfers SET expires_at = ? WHERE id = ?")
      .bind(Date.now() - 1, r.payload.id)
      .run();
    expect((await request(`/api/transfers/${r.payload.id}`, "GET", undefined, r.read)).status).toBe(
      404,
    );
    expect(
      (await request(`/api/transfers/${r.payload.id}/chunks/0`, "GET", undefined, r.read)).status,
    ).toBe(404);
    await control("cleanup");
    expect(await reserved()).toBe(0);
  });

  it("spec: concurrent creates cannot overshoot global bytes, even with deleting reservations", async () => {
    await control("config", { GLOBAL_BYTE_CAP: "64" });
    const items = [fixture(), fixture(), fixture(), fixture()];
    const responses = await Promise.all(
      items.map((f) => request("/api/transfers", "POST", JSON.stringify(f.payload))),
    );
    expect(responses.map((r) => r.status).sort()).toEqual([201, 201, 429, 429]);
    expect(await reserved()).toBe(64);
    const first = items[responses.findIndex((r) => r.status === 201)];
    expect(first).toBeDefined();
    if (!first) throw new Error("No transfer was created");
    expect((await upload(first)).status).toBe(201);
    await control("delete-fail");
    await request(`/api/transfers/${first.payload.id}`, "DELETE", undefined, first.manage);
    await control("cleanup");
    expect(await reserved()).toBe(64);
    expect(
      (await request("/api/transfers", "POST", JSON.stringify(fixture().payload))).status,
    ).toBe(429);
    await control("delete-ok");
    await control("cleanup");
    expect(await reserved()).toBe(32);
  });

  it("spec: simultaneous IP and global daily rate caps are atomic and retain no raw IP", async () => {
    await control("config", { IP_CREATE_LIMIT: "2" });
    let responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        request("/api/transfers", "POST", JSON.stringify(fixture().payload)),
      ),
    );
    expect(responses.map((r) => r.status).sort()).toEqual([201, 201, 429, 429, 429]);
    await control("config", { IP_CREATE_LIMIT: "100", GLOBAL_CREATE_LIMIT: "3" });
    responses = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        request("/api/transfers", "POST", JSON.stringify(fixture().payload), undefined, {
          "CF-Connecting-IP": `192.0.2.${i + 2}`,
        }),
      ),
    );
    expect(responses.map((r) => r.status).sort()).toEqual([201, 429, 429, 429, 429]);
    const rows = await runtime.db.prepare("SELECT * FROM rate_limits").all();
    expect(JSON.stringify(rows)).not.toContain("192.0.2.");
  });

  it("spec: simultaneous same-index PUT cannot overwrite an immutable chunk", async () => {
    const f = await create();
    const responses = await Promise.all([
      upload(f, 0, new Uint8Array(32).fill(1)),
      upload(f, 0, new Uint8Array(32).fill(2)),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
    expect((await complete(f)).status).toBe(200);
    const bytes = new Uint8Array(
      await (
        await request(`/api/transfers/${f.payload.id}/chunks/0`, "GET", undefined, f.read)
      ).arrayBuffer(),
    );
    expect(bytes).toEqual(new Uint8Array(32).fill(responses[0]?.status === 201 ? 1 : 2));
    expect((await runtime.bucket.list()).objects).toHaveLength(1);
  });

  it("spec: slow PUT cannot complete or resurrect after revoke and repeated concurrent GC", async () => {
    const f = await create();
    await control("hold");
    const put = upload(f);
    await waitForPut();
    expect((await complete(f)).status).toBe(409);
    expect(
      (await request(`/api/transfers/${f.payload.id}`, "DELETE", undefined, f.manage)).status,
    ).toBe(204);
    await Promise.all([control("cleanup"), control("cleanup")]);
    expect(await reserved()).toBe(32);
    await control("release");
    const putResult = await put;
    expect(putResult.status, await putResult.clone().text()).toBe(404);
    await Promise.all([control("cleanup"), control("cleanup")]);
    expect((await runtime.bucket.list()).objects).toHaveLength(0);
    expect(await reserved()).toBe(0);
    expect((await request(`/api/transfers/${f.payload.id}`, "GET", undefined, f.read)).status).toBe(
      404,
    );
    expect((await request("/api/transfers", "POST", JSON.stringify(f.payload))).status).toBe(409);
  });

  it("spec: delete failures leave a durable tombstone and reserve bytes until physical deletion", async () => {
    const f = await ready();
    await control("delete-fail");
    expect(
      (await request(`/api/transfers/${f.payload.id}`, "DELETE", undefined, f.manage)).status,
    ).toBe(204);
    await control("cleanup");
    expect((await runtime.bucket.list()).objects).toHaveLength(1);
    expect(await reserved()).toBe(32);
    expect((await request(`/api/transfers/${f.payload.id}`, "GET", undefined, f.read)).status).toBe(
      404,
    );
    expect((await runtime.db.prepare("SELECT * FROM chunks").all()).results).toHaveLength(1);
    await control("delete-ok");
    await Promise.all([control("cleanup"), control("cleanup")]);
    expect(await reserved()).toBe(0);
    expect((await runtime.bucket.list()).objects).toHaveLength(0);
    await control("cleanup");
    expect(await reserved()).toBe(0);
  });

  it("spec: R2 completion failure after persistence stays inaccessible and is reclaimed safely", async () => {
    const f = await create();
    await control("put-fail");
    expect((await upload(f)).status).toBe(503);
    expect((await complete(f)).status).toBe(409);
    expect((await upload(f)).status).toBe(409);
    await request(`/api/transfers/${f.payload.id}`, "DELETE", undefined, f.manage);
    await control("cleanup");
    expect((await runtime.bucket.list()).objects).toHaveLength(0);
    expect(await reserved()).toBe(0);
  });

  it("spec: GC is bounded, preserves active transfers and prunes obsolete rate rows", async () => {
    const live = await ready();
    const stale = await Promise.all(Array.from({ length: 23 }, () => create()));
    for (const f of stale)
      await runtime.db
        .prepare("UPDATE transfers SET upload_deadline = ? WHERE id = ?")
        .bind(Date.now() - 1, f.payload.id)
        .run();
    await runtime.db
      .prepare("INSERT INTO rate_limits (key,count,expires_at) VALUES ('obsolete',1,1)")
      .run();
    await control("cleanup");
    const unreleased = await runtime.db
      .prepare("SELECT id FROM transfers WHERE id != ? AND reserved_bytes > 0")
      .bind(live.payload.id)
      .all();
    expect(unreleased.results.length).toBeGreaterThanOrEqual(3);
    expect(
      (await request(`/api/transfers/${live.payload.id}`, "GET", undefined, live.read)).status,
    ).toBe(200);
    expect(
      await runtime.db.prepare("SELECT * FROM rate_limits WHERE key = 'obsolete'").first(),
    ).toBeNull();
    await control("cleanup");
    expect(await reserved()).toBe(32);
  });

  it("spec: simultaneous complete and revoke never restore read authority", async () => {
    const f = await create();
    expect((await upload(f)).status).toBe(201);
    const [completed, deleted] = await Promise.all([
      complete(f),
      request(`/api/transfers/${f.payload.id}`, "DELETE", undefined, f.manage),
    ]);
    expect([200, 404]).toContain(completed.status);
    expect(deleted.status).toBe(204);
    expect((await request(`/api/transfers/${f.payload.id}`, "GET", undefined, f.read)).status).toBe(
      404,
    );
    expect(
      (
        await runtime.db
          .prepare("SELECT state FROM transfers WHERE id = ?")
          .bind(f.payload.id)
          .first<{ state: string }>()
      )?.state,
    ).toBe("revoked");
    await control("cleanup");
    expect(await reserved()).toBe(0);
  });

  it("spec: a delayed ciphertext GET rechecks revoke before returning any data", async () => {
    const f = await ready();
    await control("hold");
    const read = request(`/api/transfers/${f.payload.id}/chunks/0`, "GET", undefined, f.read);
    await waitForPut();
    await request(`/api/transfers/${f.payload.id}`, "DELETE", undefined, f.manage);
    await control("release");
    const response = await read;
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
  });

  it("spec: an upload crossing its deadline cannot finalize or release its live lease early", async () => {
    const f = await create();
    await control("hold");
    const put = upload(f);
    await waitForPut();
    await runtime.db
      .prepare("UPDATE transfers SET upload_deadline = ? WHERE id = ?")
      .bind(Date.now() - 1, f.payload.id)
      .run();
    await control("cleanup");
    expect(await reserved()).toBe(32);
    await control("release");
    expect((await put).status).toBe(404);
    await control("cleanup");
    expect(await reserved()).toBe(0);
    expect((await runtime.bucket.list()).objects).toHaveLength(0);
  });

  it("spec: incremental oversized JSON and invalid UTF-8 never modify persistence", async () => {
    const before = await snapshot();
    const stream = new ReadableStream({
      start(c) {
        for (let i = 0; i < 17; i++) c.enqueue(new Uint8Array(1000).fill(32));
        c.close();
      },
    });
    expect(
      (
        await request("/api/transfers", "POST", stream, undefined, {
          "Content-Type": "application/json",
        })
      ).status,
    ).toBe(413);
    expect(
      (
        await request("/api/transfers", "POST", new Uint8Array([123, 255, 125]), undefined, {
          "Content-Type": "application/json",
        })
      ).status,
    ).toBe(400);
    expect(await snapshot()).toEqual(before);
  });

  it("spec: persisted quota equals reservations after cleanup races and reclaimed capacity is reusable", async () => {
    await control("config", { GLOBAL_BYTE_CAP: "32" });
    const f = await ready();
    await request(`/api/transfers/${f.payload.id}`, "DELETE", undefined, f.manage);
    await Promise.all([control("cleanup"), control("cleanup")]);
    const bytes = await runtime.db
      .prepare("SELECT reserved_bytes AS bytes FROM storage_quota WHERE singleton = 1")
      .first<{ bytes: number }>();
    expect(bytes?.bytes).toBe(await reserved());
    expect(bytes?.bytes).toBe(0);
    const responses = await Promise.all([
      request("/api/transfers", "POST", JSON.stringify(fixture().payload)),
      request("/api/transfers", "POST", JSON.stringify(fixture().payload)),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([201, 429]);
    expect(
      (
        await runtime.db
          .prepare("SELECT reserved_bytes AS bytes FROM storage_quota WHERE singleton = 1")
          .first<{ bytes: number }>()
      )?.bytes,
    ).toBe(32);
    expect(await reserved()).toBe(32);
  });

  it("spec: GC deletes at most 24 real chunks per drain without prematurely releasing reservations", async () => {
    const fixtures = [];
    for (let n = 0; n < 13; n++) {
      const f = await create(fixture(CHUNK_BYTES + 1));
      expect((await upload(f, 0)).status).toBe(201);
      expect((await upload(f, 1)).status).toBe(201);
      await request(`/api/transfers/${f.payload.id}`, "DELETE", undefined, f.manage);
      fixtures.push(f);
    }
    expect((await runtime.bucket.list()).objects).toHaveLength(26);
    await control("cleanup");
    expect((await runtime.bucket.list()).objects).toHaveLength(2);
    expect(await reserved()).toBe(fixtures[0]?.payload.cipherBytes);
    await control("cleanup");
    expect((await runtime.bucket.list()).objects).toHaveLength(0);
    expect(await reserved()).toBe(0);
  });
});
