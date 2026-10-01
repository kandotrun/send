import { createHash, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CHUNK_BYTES, ENVELOPE_OVERHEAD, MAX_PLAIN_BYTES } from "../src/shared/protocol";
import { ORIGIN, startWorker } from "./worker/harness";

let runtime: Awaited<ReturnType<typeof startWorker>>;
function fixture(plainBytes = 4, ttlSeconds = 3600) {
  const read = Buffer.from(randomBytes(32)).toString("base64url");
  const manage = Buffer.from(randomBytes(32)).toString("base64url");
  const hash = (token: string) =>
    createHash("sha256").update(Buffer.from(token, "base64url")).digest("base64url");
  const chunkCount = Math.max(1, Math.ceil(plainBytes / CHUNK_BYTES));
  return {
    read,
    manage,
    payload: {
      id: Buffer.from(randomBytes(16)).toString("base64url"),
      readTokenHash: hash(read),
      manageTokenHash: hash(manage),
      encryptedManifest: Buffer.from(randomBytes(40)).toString("base64url"),
      cipherBytes: plainBytes + ENVELOPE_OVERHEAD * chunkCount,
      chunkCount,
      ttlSeconds,
    },
  };
}
type Fixture = ReturnType<typeof fixture>;
function request(path: string, method = "GET", body?: string | Uint8Array, token?: string) {
  return runtime.mf.dispatchFetch(`${ORIGIN}${path}`, {
    method,
    body,
    headers: {
      "X-Test-Host": "send.test",
      "X-Test-IP": "192.0.2.1",
      ...(method !== "GET" ? { Origin: ORIGIN } : {}),
      ...(body
        ? {
            "Content-Type":
              typeof body === "string" ? "application/json" : "application/octet-stream",
          }
        : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
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
function upload(f: Fixture, index = 0) {
  const bytes =
    index === f.payload.chunkCount - 1
      ? f.payload.cipherBytes - index * (CHUNK_BYTES + ENVELOPE_OVERHEAD)
      : CHUNK_BYTES + ENVELOPE_OVERHEAD;
  return request(
    `/api/transfers/${f.payload.id}/chunks/${index}`,
    "PUT",
    new Uint8Array(bytes).fill(7),
    f.manage,
  );
}
async function revoke(f: Fixture) {
  expect(
    (await request(`/api/transfers/${f.payload.id}`, "DELETE", undefined, f.manage)).status,
  ).toBe(204);
}
async function waitForGate(gate = "", count = 1) {
  for (let n = 0; n < 200; n++) {
    const response = await request(`/__test/pending${gate}`);
    if (((await response.json()) as { pending: number }).pending >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Native R2 gate ${gate} was not reached`);
}
async function chunk(f: Fixture) {
  return runtime.db
    .prepare("SELECT * FROM chunks WHERE transfer_id = ? ORDER BY chunk_index")
    .bind(f.payload.id)
    .first<{ object_key: string; state: string }>();
}
async function reservation(f: Fixture) {
  return (
    await runtime.db
      .prepare("SELECT reserved_bytes AS bytes FROM transfers WHERE id = ?")
      .bind(f.payload.id)
      .first<{ bytes: number }>()
  )?.bytes;
}
async function expectQuotaConsistent() {
  const summed = await runtime.db
    .prepare("SELECT COALESCE(SUM(reserved_bytes),0) AS bytes FROM transfers")
    .first<{ bytes: number }>();
  const quota = await runtime.db
    .prepare("SELECT reserved_bytes AS bytes FROM storage_quota WHERE singleton = 1")
    .first<{ bytes: number }>();
  expect(quota?.bytes).toBe(summed?.bytes);
}
async function expectFence(key: string) {
  const object = await runtime.bucket.head(key);
  expect(object).not.toBeNull();
  expect(object?.size).toBe(0);
  expect(object?.customMetadata).toEqual({ sendLeaseFence: "1" });
}
async function expectRevoked(f: Fixture) {
  expect(
    (await request(`/api/transfers/${f.payload.id}/complete`, "POST", "{}", f.manage)).status,
  ).toBe(404);
  expect((await request(`/api/transfers/${f.payload.id}`, "GET", undefined, f.read)).status).toBe(
    404,
  );
  expect(
    (await request(`/api/transfers/${f.payload.id}/chunks/0`, "GET", undefined, f.read)).status,
  ).toBe(404);
  expect((await request("/api/transfers", "POST", JSON.stringify(f.payload))).status).toBe(409);
}
async function seedWriting(f: Fixture, key = `${f.payload.id}/0/crashed`) {
  await runtime.db
    .prepare(
      "INSERT INTO chunks (transfer_id,chunk_index,object_key,state,bytes,started_at) VALUES (?,0,?,'writing',32,1)",
    )
    .bind(f.payload.id, key)
    .run();
  return key;
}

describe("spec: native D1/R2 admission and permanent lease fencing", () => {
  beforeEach(async () => {
    runtime = await startWorker();
  }, 60000);
  afterEach(async () => {
    // Release intentionally deferred native calls even when a RED assertion fails.
    for (const suffix of ["", "-fence", "-put-settled", "-put-unsettled", "-head"])
      await control(`release${suffix}`);
    await control("drain-put-unsettled");
    await runtime?.mf.dispose();
  }, 60000);

  it("admits exactly decimal 10GB and the final index in the native schema without allocating 10GB", async () => {
    await control("config", { GLOBAL_BYTE_CAP: "10000066780" });
    expect(MAX_PLAIN_BYTES).toBe(10_000_000_000);
    const f = await create(fixture(10_000_000_000));
    expect(f.payload.chunkCount).toBe(2385);
    expect(f.payload.cipherBytes).toBe(10_000_066_780);
    expect(await reservation(f)).toBe(10_000_066_780);
    expect((await upload(f, 2384)).status).toBe(201);
    expect(
      (
        await request(
          `/api/transfers/${f.payload.id}/chunks/2385`,
          "PUT",
          new Uint8Array(28),
          f.manage,
        )
      ).status,
    ).toBe(400);
    expect(
      (await request("/api/transfers", "POST", JSON.stringify(fixture().payload))).status,
    ).toBe(429);
    await expectQuotaConsistent();
  });

  it("rejects 10GB plus one byte without changing native D1 admission, rate or quota rows", async () => {
    await control("config", { GLOBAL_BYTE_CAP: "100000000000" });
    const before = await Promise.all(
      ["transfers", "rate_limits", "storage_quota", "chunks"].map(
        async (table) => (await runtime.db.prepare(`SELECT * FROM ${table}`).all()).results,
      ),
    );
    const response = await request(
      "/api/transfers",
      "POST",
      JSON.stringify(fixture(10_000_000_001).payload),
    );
    expect(response.status).toBe(400);
    // Native schema also rejects bypassing HTTP validation; INSERT triggers stay atomic.
    const invalid = fixture(10_000_000_001).payload;
    await expect(
      runtime.db
        .prepare(`INSERT INTO transfers
      (id,read_token_hash,manage_token_hash,encrypted_manifest,cipher_bytes,chunk_count,created_at,expires_at,upload_deadline,reserved_bytes,create_ip_key,create_day_key,ip_rate_expires,day_rate_expires)
      VALUES (?,?,?,?,?,?,0,3600000,3600000,?,'boundary-ip','boundary-day',3600000,3600000)`)
        .bind(
          invalid.id,
          invalid.readTokenHash,
          invalid.manageTokenHash,
          invalid.encryptedManifest,
          invalid.cipherBytes,
          invalid.chunkCount,
          invalid.cipherBytes,
        )
        .run(),
    ).rejects.toThrow(/CHECK constraint/);
    const after = await Promise.all(
      ["transfers", "rate_limits", "storage_quota", "chunks"].map(
        async (table) => (await runtime.db.prepare(`SELECT * FROM ${table}`).all()).results,
      ),
    );
    expect(after).toEqual(before);
  });

  it("sets the upload deadline to the earlier of expiry and 24 hours", async () => {
    for (const ttl of [3600, 86400, 604800]) {
      const f = await create(fixture(4, ttl));
      const row = await runtime.db
        .prepare("SELECT created_at,expires_at,upload_deadline FROM transfers WHERE id = ?")
        .bind(f.payload.id)
        .first<{ created_at: number; expires_at: number; upload_deadline: number }>();
      expect(row?.upload_deadline).toBe(
        Math.min(row?.expires_at ?? 0, (row?.created_at ?? 0) + 86_400_000),
      );
    }
  });

  it("fences a crashed absent PUT before releasing its lease and payload reservation", async () => {
    const f = await create();
    const key = await seedWriting(f);
    await revoke(f);
    await Promise.all([control("cleanup"), control("cleanup")]);
    await expectFence(key);
    expect(await chunk(f)).toBeNull();
    expect(await reservation(f)).toBe(0);
    expect(
      await runtime.bucket.put(key, new Uint8Array(32), { onlyIf: { etagDoesNotMatch: "*" } }),
    ).toBeNull();
    await Promise.all([control("cleanup"), control("cleanup")]);
    await expectFence(key);
    await expectQuotaConsistent();
    await expectRevoked(f);
  });

  it("fences persisted crashed ciphertext with If-Match instead of deleting its key", async () => {
    const f = await create();
    const key = await seedWriting(f);
    const original = await runtime.bucket.put(key, new Uint8Array(32).fill(9), {
      onlyIf: { etagDoesNotMatch: "*" },
    });
    expect(original?.size).toBe(32);
    await revoke(f);
    await control("cleanup");
    await expectFence(key);
    expect(await chunk(f)).toBeNull();
    expect(await reservation(f)).toBe(0);
    await expectQuotaConsistent();
  });

  it("a delayed original native PUT loses to the fence and never reports stored or ready", async () => {
    const f = await create();
    await control("hold");
    const put = upload(f);
    await waitForGate();
    const lease = await chunk(f);
    expect(lease?.state).toBe("writing");
    await revoke(f);
    await Promise.all([control("cleanup"), control("cleanup")]);
    await expectFence(lease?.object_key ?? "missing");
    expect(await reservation(f)).toBe(0);
    await control("release");
    expect((await put).status).toBe(404);
    expect(await chunk(f)).toBeNull();
    await control("cleanup");
    await expectFence(lease?.object_key ?? "missing");
    const calls = (await (await request("/__test/storage-calls")).json()) as {
      op: string;
      fence?: boolean;
      size?: number | null;
    }[];
    expect(
      calls.some((call) => call.op === "put" && call.fence === false && call.size === null),
    ).toBe(true);
    expect(calls.some((call) => call.op === "delete")).toBe(false);
    await expectRevoked(f);
    await expectQuotaConsistent();
  });

  it("a caller-side PUT rejection before native settlement cannot recreate ciphertext after GC", async () => {
    const f = await create();
    await control("hold-put-unsettled");
    await control("put-fail-before-settled");
    try {
      const put = upload(f);
      await waitForGate("-put-unsettled");
      expect((await put).status).toBe(503);
      const lease = await chunk(f);
      const key = lease?.object_key ?? "missing";
      expect(lease).not.toBeNull();
      expect(await runtime.bucket.head(key)).toBeNull();
      expect(await reservation(f)).toBe(32);
      await expectQuotaConsistent();
      await revoke(f);
      await Promise.all([control("cleanup"), control("cleanup")]);
      const beforeRelease = await runtime.bucket.head(key);
      expect(await chunk(f)).toBeNull();
      expect(await reservation(f)).toBe(0);
      await expectQuotaConsistent();
      await control("release-put-unsettled");
      const nativeResults = await (await control("drain-put-unsettled")).json();
      const afterRelease = await runtime.bucket.head(key);
      // Promise rejection is not native settlement: the original immutable PUT
      // must lose to a durable zero-byte fence, never recreate untracked payload.
      expect({
        beforeRelease: beforeRelease?.size ?? null,
        nativeResults,
        afterRelease: afterRelease?.size ?? null,
      }).toEqual({
        beforeRelease: 0,
        nativeResults: [{ key, size: null }],
        afterRelease: 0,
      });
      await expectFence(key);
      await Promise.all([control("cleanup"), control("cleanup")]);
      await expectFence(key);
      expect(await reservation(f)).toBe(0);
      await expectQuotaConsistent();
      await expectRevoked(f);
    } finally {
      await control("release-put-unsettled");
      await control("drain-put-unsettled");
    }
  });

  it("a rejected PUT with persisted native ciphertext is conservatively fenced rather than deleted", async () => {
    const f = await create();
    await control("put-fail");
    expect((await upload(f)).status).toBe(503);
    const lease = await chunk(f);
    const key = lease?.object_key ?? "missing";
    expect(lease?.state).toBe("failed");
    expect((await runtime.bucket.head(key))?.size).toBe(32);
    await revoke(f);
    await Promise.all([control("cleanup"), control("cleanup")]);
    await expectFence(key);
    expect(await chunk(f)).toBeNull();
    expect(await reservation(f)).toBe(0);
    await expectQuotaConsistent();
    const calls = (await (await request("/__test/storage-calls")).json()) as { op: string }[];
    expect(calls.some((call) => call.op === "delete")).toBe(false);
  });

  it("a delayed successful PUT result cannot finalize after ciphertext is replaced by the fence", async () => {
    const f = await create();
    await control("hold-put-settled");
    const put = upload(f);
    await waitForGate("-put-settled");
    const lease = await chunk(f);
    expect((await runtime.bucket.head(lease?.object_key ?? "missing"))?.size).toBe(32);
    await revoke(f);
    await control("cleanup");
    await expectFence(lease?.object_key ?? "missing");
    expect(await reservation(f)).toBe(0);
    await control("release-put-settled");
    expect((await put).status).toBe(404);
    await expectRevoked(f);
  });

  it("a writer failure racing two GCs cannot send a fenced key through the failed-object delete path", async () => {
    const f = await create();
    await control("hold-put-settled");
    await control("put-fail");
    const put = upload(f);
    await waitForGate("-put-settled");
    const lease = await chunk(f);
    await revoke(f);
    await control("hold-fence");
    const gc1 = control("cleanup");
    await waitForGate("-fence");
    await control("release-put-settled");
    expect([404, 503]).toContain((await put).status);
    const gc2 = control("cleanup");
    await waitForGate("-fence", 2);
    expect(await reservation(f)).toBe(32);
    await control("release-fence");
    await Promise.all([gc1, gc2]);
    await control("cleanup");
    await expectFence(lease?.object_key ?? "missing");
    const calls = (await (await request("/__test/storage-calls")).json()) as { op: string }[];
    expect(calls.some((call) => call.op === "delete")).toBe(false);
    expect(await reservation(f)).toBe(0);
    expect(await chunk(f)).toBeNull();
    await expectQuotaConsistent();
  });

  it("failed and stored GC paths recognize an existing tagged fence and never delete it", async () => {
    for (const state of ["failed", "stored"]) {
      const f = await create();
      const key = await seedWriting(f);
      await runtime.db
        .prepare("UPDATE chunks SET state = ? WHERE object_key = ?")
        .bind(state, key)
        .run();
      await runtime.bucket.put(key, new Uint8Array(0), {
        onlyIf: { etagDoesNotMatch: "*" },
        customMetadata: { sendLeaseFence: "1" },
      });
      await revoke(f);
      await control("cleanup");
      await expectFence(key);
      expect(await chunk(f)).toBeNull();
      expect(await reservation(f)).toBe(0);
    }
    const calls = (await (await request("/__test/storage-calls")).json()) as { op: string }[];
    expect(calls.some((call) => call.op === "delete")).toBe(false);
  });

  it("fence, ambiguous fence-completion and head failures retain lease and quota until retry", async () => {
    for (const failure of ["fence-fail", "fence-fail-after", "head-fail", "fence-head-fail"]) {
      const f = await create();
      const key = await seedWriting(f);
      await revoke(f);
      await control(failure);
      await control("cleanup");
      expect(await chunk(f)).not.toBeNull();
      expect(await reservation(f)).toBe(32);
      await expectQuotaConsistent();
      await control("fence-ok");
      await control("head-ok");
      await control("cleanup");
      await expectFence(key);
      expect(await chunk(f)).toBeNull();
      expect(await reservation(f)).toBe(0);
    }
  });

  it("a real fence conditional miss retains its durable lease for the next drain", async () => {
    const f = await create();
    const key = await seedWriting(f);
    await revoke(f);
    await control("hold-fence");
    const gc = control("cleanup");
    await waitForGate("-fence");
    // The original immutable PUT wins the race after GC observed an absent key.
    expect(
      (await runtime.bucket.put(key, new Uint8Array(32), { onlyIf: { etagDoesNotMatch: "*" } }))
        ?.size,
    ).toBe(32);
    await control("release-fence");
    await gc;
    expect(await chunk(f)).not.toBeNull();
    expect(await reservation(f)).toBe(32);
    expect((await runtime.bucket.head(key))?.size).toBe(32);
    await control("cleanup");
    await expectFence(key);
    expect(await reservation(f)).toBe(0);
  });

  it("expiry irrevocably revokes and fences a crashed writing lease without waiting for its PUT", async () => {
    const f = await create();
    const key = await seedWriting(f);
    await runtime.db
      .prepare("UPDATE transfers SET upload_deadline = 1 WHERE id = ?")
      .bind(f.payload.id)
      .run();
    await control("cleanup");
    await expectFence(key);
    expect(await reservation(f)).toBe(0);
    await expectRevoked(f);
  });

  it("failed early chunk cleanup rotates to later indices instead of starving them forever", async () => {
    const f = await create(fixture(65 * CHUNK_BYTES));
    await runtime.db.batch(
      Array.from({ length: 65 }, (_, index) =>
        runtime.db
          .prepare(
            "INSERT INTO chunks (transfer_id,chunk_index,object_key,state,bytes,started_at) VALUES (?,?,?,'writing',28,1)",
          )
          .bind(f.payload.id, index, `${f.payload.id}/${index}/crashed`),
      ),
    );
    await revoke(f);
    await control("head-fail");
    await control("cleanup");
    const state = async () =>
      (
        await runtime.db
          .prepare("SELECT state FROM chunks WHERE transfer_id = ? AND chunk_index = 64")
          .bind(f.payload.id)
          .first<{ state: string }>()
      )?.state;
    expect(await state()).toBe("writing");
    await control("cleanup");
    expect(await state()).toBe("fencing");
    expect(await reservation(f)).toBe(f.payload.cipherBytes);
    await expectQuotaConsistent();
  });

  it("a stale If-Match fence cannot replace an object it did not observe", async () => {
    const f = await create();
    const key = await seedWriting(f);
    await runtime.bucket.put(key, new Uint8Array(32).fill(7));
    await revoke(f);
    await control("hold-fence");
    const gc = control("cleanup");
    await waitForGate("-fence");
    await runtime.bucket.put(key, new Uint8Array(32).fill(8));
    await control("release-fence");
    await gc;
    expect(await chunk(f)).not.toBeNull();
    expect(await reservation(f)).toBe(32);
    expect((await runtime.bucket.head(key))?.size).toBe(32);
    await control("cleanup");
    await expectFence(key);
    expect(await reservation(f)).toBe(0);
  });

  it("a confirmed writing fence does not release the reservation while another chunk deletion fails", async () => {
    const f = await create(fixture(CHUNK_BYTES + 1));
    const key = await seedWriting(f);
    expect((await upload(f, 1)).status).toBe(201);
    await revoke(f);
    await control("delete-fail");
    await control("cleanup");
    await expectFence(key);
    expect(await reservation(f)).toBe(f.payload.cipherBytes);
    expect(await chunk(f)).toMatchObject({ state: "stored" });
    await expectQuotaConsistent();
    await control("delete-ok");
    await Promise.all([control("cleanup"), control("cleanup")]);
    await expectFence(key);
    expect(await chunk(f)).toBeNull();
    expect(await reservation(f)).toBe(0);
    await expectQuotaConsistent();
  });

  it("drains at most 64 native objects and rotates to other transfers before continuing a large transfer", async () => {
    // Small native payloads exercise cleanup without allocating the declared plaintext size.
    const large: Fixture[] = [];
    for (const count of [23, 23, 19]) {
      const f = await create(fixture(count * CHUNK_BYTES));
      large.push(f);
      const keys = Array.from({ length: count }, (_, index) => `${f.payload.id}/${index}/stored`);
      await runtime.db.batch(
        keys.map((key, index) =>
          runtime.db
            .prepare(
              "INSERT INTO chunks (transfer_id,chunk_index,object_key,state,bytes,started_at) VALUES (?,?,?,'stored',28,1)",
            )
            .bind(f.payload.id, index, key),
        ),
      );
      for (const key of keys) await runtime.bucket.put(key, new Uint8Array(28));
      await revoke(f);
    }
    const small = await create();
    const smallKey = `${small.payload.id}/0/stored`;
    await runtime.db
      .prepare(
        "INSERT INTO chunks (transfer_id,chunk_index,object_key,state,bytes,started_at) VALUES (?,0,?,'stored',32,1)",
      )
      .bind(small.payload.id, smallKey)
      .run();
    await runtime.bucket.put(smallKey, new Uint8Array(32));
    await revoke(small);
    await control("cleanup");
    expect((await runtime.bucket.list()).objects).toHaveLength(2);
    expect(await reservation(large[0] as Fixture)).toBe(0);
    expect(await reservation(large[1] as Fixture)).toBe(0);
    expect(await reservation(large[2] as Fixture)).toBe(large[2]?.payload.cipherBytes);
    expect(await reservation(small)).toBe(32);
    await control("cleanup");
    expect((await runtime.bucket.list()).objects).toHaveLength(0);
    expect(await reservation(large[2] as Fixture)).toBe(0);
    expect(await reservation(small)).toBe(0);
    const calls = (await (await request("/__test/storage-calls")).json()) as {
      op: string;
      key: string;
    }[];
    expect(calls.filter((call) => call.op === "delete")[64]?.key).toBe(smallKey);
    await expectQuotaConsistent();
  });
});
