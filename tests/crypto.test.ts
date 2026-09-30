import { describe, expect, it } from "vitest";
import {
  buildManageUrl,
  buildReadUrl,
  decodeBase64Url,
  decryptChunk,
  decryptManifest,
  deriveKeys,
  encodeBase64Url,
  encryptChunk,
  encryptManifest,
  generateSecrets,
  hashSecret,
  parseManageLink,
  parseReadLink,
  validateManifest,
} from "../src/client/crypto";
import { CHUNK_BYTES, MAX_PLAIN_BYTES, type Manifest } from "../src/shared/protocol";

const id = "AAECAwQFBgcICQoLDA0ODw";
const key = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
const manifest = (changes: Record<string, unknown> = {}): Manifest =>
  ({
    version: 1,
    id,
    kind: "file",
    name: "日本語.txt",
    mime: "text/plain",
    size: 5,
    chunkCount: 1,
    chunkBytes: CHUNK_BYTES,
    ttlSeconds: 3600,
    ...changes,
  }) as Manifest;

// サーバーに平文や復号鍵を渡さないための暗号境界。
describe("send v1 crypto", () => {
  it("classifies authentication failure as trusted decryption failure without leaking key or metadata", async () => {
    const keys = await deriveKeys(key, id);
    const wrongKeys = await deriveKeys(generateSecrets().key, id);
    const encryptedManifest = await encryptManifest(keys, manifest());
    const encryptedChunk = await encryptChunk(keys, id, 0, new Uint8Array([1]));
    for (const decrypt of [
      () => decryptManifest(wrongKeys, id, encryptedManifest),
      () => decryptChunk(wrongKeys, id, 0, encryptedChunk),
    ]) {
      const failure = await decrypt().catch((error: unknown) => error);
      expect(failure).toMatchObject({
        code: "decryption",
        message: "復号できません。リンクまたは暗号データを確認してください。",
      });
      expect((failure as Error).cause).toBeUndefined();
      expect((failure as Error).message).not.toContain(key);
      expect((failure as Error).message).not.toContain("日本語.txt");
    }
  });

  it("generates independent canonical 128-bit IDs and 256-bit secrets", () => {
    const first = generateSecrets();
    const second = generateSecrets();
    expect(decodeBase64Url(first.id, 16)).toHaveLength(16);
    for (const secret of [first.key, first.readToken, first.manageToken]) {
      expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(decodeBase64Url(secret, 32)).toHaveLength(32);
    }
    expect(new Set([first.key, first.readToken, first.manageToken, second.key]).size).toBe(4);
    expect(first.id).not.toBe(second.id);
  });

  it("uses canonical unpadded base64url and rejects alternate encodings", () => {
    expect(encodeBase64Url(new Uint8Array([255, 254, 253]))).toBe("__79");
    expect([...decodeBase64Url("__79")]).toEqual([255, 254, 253]);
    for (const invalid of ["AA=", "AA\n", "A", "+w", "/w", "AB", "AAA=", "AAB", "é"]) {
      expect(() => decodeBase64Url(invalid)).toThrow();
    }
    expect(() => decodeBase64Url("AA", 32)).toThrow();
    expect(() => decodeBase64Url("AAAA", undefined, 2)).toThrow();
  });

  it("hashes raw capability secret bytes with SHA-256", async () => {
    const expected = new Uint8Array(await crypto.subtle.digest("SHA-256", decodeBase64Url(key)));
    expect(await hashSecret(key)).toBe(encodeBase64Url(expected));
    expect(await hashSecret(key)).not.toBe(key);
    await expect(hashSecret("not-a-secret")).rejects.toThrow();
  });

  it("derives distinct nonextractable AES-256 keys with exact HKDF context", async () => {
    const keys = await deriveKeys(key, id);
    expect(keys.manifest.extractable).toBe(false);
    expect(keys.chunk.extractable).toBe(false);
    const root = await crypto.subtle.importKey("raw", decodeBase64Url(key), "HKDF", false, [
      "deriveKey",
    ]);
    const expected = await crypto.subtle.deriveKey(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: new TextEncoder().encode(id),
        info: new TextEncoder().encode("send/v1/chunk"),
      },
      root,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
    const envelope = await encryptChunk(keys, id, 0, new Uint8Array([1, 2, 3]));
    expect(envelope).toHaveLength(31);
    const plain = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: envelope.slice(0, 12),
        additionalData: new TextEncoder().encode(`send/v1/${id}/chunk/0`),
        tagLength: 128,
      },
      expected,
      envelope.slice(12),
    );
    expect([...new Uint8Array(plain)]).toEqual([1, 2, 3]);
    await expect(
      crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: envelope.slice(0, 12),
          additionalData: new TextEncoder().encode(`send/v1/${id}/chunk/0`),
        },
        keys.manifest,
        envelope.slice(12),
      ),
    ).rejects.toThrow();
  });

  it("encrypts/decrypts manifests with fresh nonces and authenticated identity", async () => {
    const keys = await deriveKeys(key, id);
    const first = await encryptManifest(keys, manifest());
    const second = await encryptManifest(keys, manifest());
    expect(first).not.toEqual(second);
    expect(await decryptManifest(keys, id, first)).toEqual(manifest());
    const wrongKeys = await deriveKeys(generateSecrets().key, id);
    await expect(decryptManifest(wrongKeys, id, first)).rejects.toThrow();
    await expect(decryptManifest(keys, generateSecrets().id, first)).rejects.toThrow();
    const corrupted = first.slice();
    corrupted[corrupted.length - 1] = (corrupted[corrupted.length - 1] ?? 0) ^ 1;
    await expect(decryptManifest(keys, id, corrupted)).rejects.toThrow();
    await expect(decryptManifest(keys, id, first.slice(0, -1))).rejects.toThrow();
  });

  it("binds chunk order/identity and authenticates every byte including empty chunks", async () => {
    const keys = await deriveKeys(key, id);
    const encrypted = await encryptChunk(keys, id, 1, new Uint8Array([4, 5, 6]));
    expect([...(await decryptChunk(keys, id, 1, encrypted))]).toEqual([4, 5, 6]);
    await expect(decryptChunk(keys, id, 0, encrypted)).rejects.toThrow();
    await expect(decryptChunk(keys, generateSecrets().id, 1, encrypted)).rejects.toThrow();
    await expect(
      decryptChunk(await deriveKeys(generateSecrets().key, id), id, 1, encrypted),
    ).rejects.toThrow();
    const tampered = encrypted.slice();
    tampered[12] = (tampered[12] ?? 0) ^ 1;
    await expect(decryptChunk(keys, id, 1, tampered)).rejects.toThrow();
    await expect(decryptChunk(keys, id, 1, encrypted.slice(0, -1))).rejects.toThrow();
    const empty = await encryptChunk(keys, id, 0, new Uint8Array());
    expect(empty).toHaveLength(28);
    expect(await decryptChunk(keys, id, 0, empty)).toHaveLength(0);
    await expect(encryptChunk(keys, id, -1, new Uint8Array())).rejects.toThrow();
    await expect(encryptChunk(keys, id, 0, new Uint8Array(CHUNK_BYTES + 1))).rejects.toThrow();
  });

  it("validates authenticated manifest fields and returns only verified metadata", () => {
    expect(validateManifest(manifest(), id)).toEqual(manifest());
    expect(validateManifest(manifest({ size: 0 }), id).chunkCount).toBe(1);
    expect(
      validateManifest(
        manifest({
          size: MAX_PLAIN_BYTES,
          chunkCount: Math.ceil(MAX_PLAIN_BYTES / CHUNK_BYTES),
          ttlSeconds: 604800,
        }),
        id,
      ).size,
    ).toBe(MAX_PLAIN_BYTES);
    for (const value of [
      null,
      [],
      {},
      manifest({ version: 2 }),
      manifest({ id: generateSecrets().id }),
      manifest({ kind: "html" }),
      manifest({ name: "x".repeat(256) }),
      manifest({ name: "\u0000" }),
      manifest({ mime: "x".repeat(256) }),
      manifest({ mime: "text/plain\r\nX: y" }),
      manifest({ size: -1 }),
      manifest({ size: MAX_PLAIN_BYTES + 1 }),
      manifest({ size: 1.5 }),
      manifest({ chunkCount: 0 }),
      manifest({ chunkCount: 2 }),
      manifest({ chunkBytes: 1 }),
      manifest({ ttlSeconds: 60 }),
      manifest({ unexpected: key }),
      manifest({ name: 4 }),
    ]) {
      expect(() => validateManifest(value, id)).toThrow();
    }
  });

  it("rejects correctly encrypted but invalid JSON or mismatched metadata", async () => {
    const keys = await deriveKeys(key, id);
    for (const plaintext of [
      "not json",
      JSON.stringify(manifest({ chunkCount: 2 })),
      JSON.stringify(manifest({ id: generateSecrets().id })),
    ]) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const encrypted = new Uint8Array(
        await crypto.subtle.encrypt(
          {
            name: "AES-GCM",
            iv,
            additionalData: new TextEncoder().encode(`send/v1/${id}/manifest`),
          },
          keys.manifest,
          new TextEncoder().encode(plaintext),
        ),
      );
      const envelope = new Uint8Array(12 + encrypted.length);
      envelope.set(iv);
      envelope.set(encrypted, 12);
      await expect(decryptManifest(keys, id, envelope)).rejects.toThrow();
    }
    await expect(decryptManifest(keys, id, new Uint8Array(8193))).rejects.toThrow();
  });

  it("builds fragment-only read and management links with strict parsing", () => {
    const read = { id, readToken: key, key };
    const manage = { id, manageToken: key };
    const readUrl = buildReadUrl("https://send.example", read);
    const manageUrl = buildManageUrl("https://send.example", manage);
    expect(readUrl).toBe(`https://send.example/#r=${id}.${key}.${key}`);
    expect(manageUrl).toBe(`https://send.example/#m=${id}.${key}`);
    expect(parseReadLink(readUrl, "https://send.example")).toEqual(read);
    expect(parseManageLink(manageUrl, "https://send.example")).toEqual(manage);
    for (const bad of [
      `https://evil.example/#r=${id}.${key}.${key}`,
      `https://send.example/?key=${key}#r=${id}.${key}.${key}`,
      `https://name:pass@send.example/#r=${id}.${key}.${key}`,
      `https://send.example/#r=${id}.${key}.${key}=`,
      `https://send.example/#r=${id}.${key}`,
      `https://send.example/#m=${id}.${key}`,
      `https://send.example/path#r=${id}.${key}.${key}`,
      `javascript:alert(1)#r=${id}.${key}.${key}`,
      `https://send.example/#r=${id}.${key}.${key}&x=1`,
      `https://send.example/path/../#r=${id}.${key}.${key}`,
      `https://@send.example/#r=${id}.${key}.${key}`,
      `https://send.example/?#r=${id}.${key}.${key}`,
      ` https://send.example/#r=${id}.${key}.${key}`,
    ]) {
      expect(() => parseReadLink(bad, "https://send.example")).toThrow();
    }
    expect(() => parseManageLink(readUrl, "https://send.example")).toThrow();
    expect(() => buildReadUrl("https://evil.example/path", read)).toThrow();
  });
});
