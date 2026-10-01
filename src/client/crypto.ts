import { TransferError } from "../shared/errors";
import {
  CHUNK_BYTES,
  ENVELOPE_OVERHEAD,
  MAX_MANIFEST_BYTES,
  MAX_PLAIN_BYTES,
  type Manifest,
} from "../shared/protocol";
import { assertId, decodeBase64Url, encodeBase64Url } from "./encoding";
import { validateManifest } from "./manifest";

export { decodeBase64Url, encodeBase64Url } from "./encoding";
export { buildManageUrl, buildReadUrl, parseManageLink, parseReadLink } from "./links";
export { validateManifest } from "./manifest";

export interface TransferSecrets {
  id: string;
  key: string;
  readToken: string;
  manageToken: string;
}
export interface TransferKeys {
  manifest: CryptoKey;
  chunk: CryptoKey;
}
const utf8 = new TextEncoder();

export function generateSecrets(): TransferSecrets {
  const random = (size: number) => encodeBase64Url(crypto.getRandomValues(new Uint8Array(size)));
  return { id: random(16), key: random(32), readToken: random(32), manageToken: random(32) };
}

export async function hashSecret(secret: string): Promise<string> {
  return encodeBase64Url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", decodeBase64Url(secret, 32))),
  );
}

export async function deriveKeys(key: string, id: string): Promise<TransferKeys> {
  assertId(id);
  const root = await crypto.subtle.importKey("raw", decodeBase64Url(key, 32), "HKDF", false, [
    "deriveKey",
  ]);
  const derive = (context: string) =>
    crypto.subtle.deriveKey(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: utf8.encode(id),
        info: utf8.encode(`send/v1/${context}`),
      },
      root,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  const [manifest, chunk] = await Promise.all([derive("manifest"), derive("chunk")]);
  return { manifest, chunk };
}

async function encrypt(
  key: CryptoKey,
  aad: string,
  plaintext: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce, additionalData: utf8.encode(aad), tagLength: 128 },
      key,
      new Uint8Array(plaintext),
    ),
  );
  const envelope = new Uint8Array(nonce.length + ciphertext.length);
  envelope.set(nonce);
  envelope.set(ciphertext, nonce.length);
  return envelope;
}

async function decrypt(
  key: CryptoKey,
  aad: string,
  envelope: Uint8Array,
  maximum: number,
): Promise<Uint8Array<ArrayBuffer>> {
  if (envelope.length < ENVELOPE_OVERHEAD || envelope.length > maximum) throw invalid();
  try {
    return new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: new Uint8Array(envelope.slice(0, 12)),
          additionalData: utf8.encode(aad),
          tagLength: 128,
        },
        key,
        new Uint8Array(envelope.slice(12)),
      ),
    );
  } catch {
    throw invalid();
  }
}

export async function encryptManifest(
  keys: TransferKeys,
  manifest: Manifest,
): Promise<Uint8Array<ArrayBuffer>> {
  const value = validateManifest(manifest, manifest.id);
  const plaintext = utf8.encode(JSON.stringify(value));
  if (plaintext.length + ENVELOPE_OVERHEAD > MAX_MANIFEST_BYTES) throw invalid();
  return encrypt(keys.manifest, `send/v1/${value.id}/manifest`, plaintext);
}

export async function decryptManifest(
  keys: TransferKeys,
  id: string,
  envelope: Uint8Array,
): Promise<Manifest> {
  assertId(id);
  const plaintext = await decrypt(
    keys.manifest,
    `send/v1/${id}/manifest`,
    envelope,
    MAX_MANIFEST_BYTES,
  );
  try {
    return validateManifest(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext)),
      id,
    );
  } catch {
    throw invalid();
  }
}

function chunkAad(id: string, index: number): string {
  assertId(id);
  if (
    !Number.isSafeInteger(index) ||
    index < 0 ||
    index >= Math.ceil(MAX_PLAIN_BYTES / CHUNK_BYTES)
  )
    throw invalid();
  return `send/v1/${id}/chunk/${index}`;
}

export async function encryptChunk(
  keys: TransferKeys,
  id: string,
  index: number,
  plaintext: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  const aad = chunkAad(id, index);
  if (plaintext.length > CHUNK_BYTES) throw invalid();
  return encrypt(keys.chunk, aad, plaintext);
}
export async function decryptChunk(
  keys: TransferKeys,
  id: string,
  index: number,
  envelope: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  return decrypt(keys.chunk, chunkAad(id, index), envelope, CHUNK_BYTES + ENVELOPE_OVERHEAD);
}
function invalid(): TransferError {
  return new TransferError("decryption");
}
