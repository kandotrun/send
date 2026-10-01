import {
  CHUNK_BYTES,
  MAX_BUFFERED_BYTES,
  MAX_PLAIN_BYTES,
  type Manifest,
  TTL_OPTIONS,
  VERSION,
} from "../shared/protocol";
import { assertId } from "./encoding";

const fields = [
  "version",
  "id",
  "kind",
  "name",
  "mime",
  "size",
  "chunkCount",
  "chunkBytes",
  "ttlSeconds",
];
const boundedString = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= 255 &&
  [...value].every((character) => {
    const code = character.charCodeAt(0);
    return code >= 32 && code !== 127;
  });

export function validateManifest(value: unknown, id: string): Manifest {
  assertId(id);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const item = value as Record<string, unknown>;
  if (
    Object.keys(item).length !== fields.length ||
    fields.some((field) => !Object.hasOwn(item, field)) ||
    item.version !== VERSION ||
    item.id !== id ||
    (item.kind !== "file" && item.kind !== "text") ||
    !boundedString(item.name) ||
    !boundedString(item.mime) ||
    !Number.isSafeInteger(item.size) ||
    (item.size as number) < 0 ||
    (item.size as number) > MAX_PLAIN_BYTES ||
    (item.kind === "text" && (item.size as number) > MAX_BUFFERED_BYTES) ||
    item.chunkBytes !== CHUNK_BYTES ||
    item.chunkCount !== Math.max(1, Math.ceil((item.size as number) / CHUNK_BYTES)) ||
    !TTL_OPTIONS.some((ttl) => item.ttlSeconds === ttl)
  )
    throw invalid();
  // コピーを返し、検証後に元のオブジェクトを書き換えられないようにする。
  return {
    version: 1,
    id,
    kind: item.kind,
    name: item.name,
    mime: item.mime,
    size: item.size as number,
    chunkCount: item.chunkCount as number,
    chunkBytes: CHUNK_BYTES,
    ttlSeconds: item.ttlSeconds as Manifest["ttlSeconds"],
  };
}

function invalid(): Error {
  return new Error("暗号化されたファイル情報が正しくありません。");
}
