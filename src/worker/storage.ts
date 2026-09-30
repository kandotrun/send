import {
  CHUNK_BYTES,
  type CreateRequest,
  ENVELOPE_OVERHEAD,
  type ManageRecord,
  type TransferRecord,
} from "../shared/protocol";
import {
  boundedBody,
  capabilityHash,
  HttpError,
  hashMatches,
  notFound,
  positiveInteger,
  rateIdentity,
  requireType,
} from "./security";

interface TransferRow {
  id: string;
  read_token_hash: string;
  manage_token_hash: string;
  encrypted_manifest: string;
  cipher_bytes: number;
  chunk_count: number;
  expires_at: number;
  upload_deadline: number;
  state: "uploading" | "ready" | "revoked";
  reserved_bytes: number;
}
interface ChunkRow {
  transfer_id: string;
  chunk_index: number;
  object_key: string;
  state: "writing" | "stored" | "failed";
  bytes: number;
}
export async function authorized(
  request: Request,
  env: Env,
  id: string,
  action: "read" | "manage" | "upload" | "delete",
): Promise<TransferRow> {
  const tokenHash = await capabilityHash(request);
  const row = await env.DB.prepare("SELECT * FROM transfers WHERE id = ?")
    .bind(id)
    .first<TransferRow>();
  if (
    !row ||
    !hashMatches(tokenHash, action === "read" ? row.read_token_hash : row.manage_token_hash)
  )
    throw notFound();
  const now = Date.now();
  if (action === "delete") return row;
  if (action === "manage" && row.state === "revoked") return row;
  if (
    row.state === "revoked" ||
    row.expires_at <= now ||
    (row.state === "uploading" && row.upload_deadline <= now) ||
    (action === "read" && row.state !== "ready")
  )
    throw notFound();
  return row;
}

export async function createTransfer(
  request: Request,
  env: Env,
  value: CreateRequest,
): Promise<{ id: string; expiresAt: number }> {
  const now = Date.now();
  const limits = {
    bytes: positiveInteger(env.GLOBAL_BYTE_CAP),
    ip: positiveInteger(env.IP_CREATE_LIMIT),
    day: positiveInteger(env.GLOBAL_CREATE_LIMIT),
  };
  const rate = await rateIdentity(request, env, now);
  const expiresAt = now + value.ttlSeconds * 1000;
  // One guarded statement, including AFTER INSERT counters, is the quota/rate transaction.
  const insert = await env.DB.prepare(`INSERT INTO transfers
    (id, read_token_hash, manage_token_hash, encrypted_manifest, cipher_bytes, chunk_count, created_at, expires_at, upload_deadline, reserved_bytes, create_ip_key, create_day_key, ip_rate_expires, day_rate_expires)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    WHERE (SELECT reserved_bytes FROM storage_quota WHERE singleton = 1) <= ? - ?
      AND COALESCE((SELECT count FROM rate_limits WHERE key = ?), 0) < ?
      AND COALESCE((SELECT count FROM rate_limits WHERE key = ?), 0) < ?
      AND NOT EXISTS (SELECT 1 FROM transfers WHERE id = ?)`)
    .bind(
      value.id,
      value.readTokenHash,
      value.manageTokenHash,
      value.encryptedManifest,
      value.cipherBytes,
      value.chunkCount,
      now,
      expiresAt,
      Math.min(expiresAt, now + 900_000),
      value.cipherBytes,
      rate.ipKey,
      rate.dayKey,
      rate.ipExpires,
      rate.dayExpires,
      limits.bytes,
      value.cipherBytes,
      rate.ipKey,
      limits.ip,
      rate.dayKey,
      limits.day,
      value.id,
    )
    .run();
  if (insert.meta.changes === 0) {
    if (await env.DB.prepare("SELECT id FROM transfers WHERE id = ?").bind(value.id).first())
      throw new HttpError(409, "conflict");
    throw new HttpError(429, "limit_reached");
  }
  return { id: value.id, expiresAt };
}

export function transferRecord(row: TransferRow): TransferRecord {
  return {
    id: row.id,
    encryptedManifest: row.encrypted_manifest,
    cipherBytes: row.cipher_bytes,
    chunkCount: row.chunk_count,
    expiresAt: row.expires_at,
  };
}
export async function manageRecord(env: Env, row: TransferRow): Promise<ManageRecord> {
  const stored = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM chunks WHERE transfer_id = ? AND state = 'stored'",
  )
    .bind(row.id)
    .first<{ count: number }>();
  return {
    id: row.id,
    state: row.state,
    chunkCount: row.chunk_count,
    uploadedChunks: stored?.count ?? 0,
    expiresAt: row.expires_at,
  };
}
export async function putChunk(
  request: Request,
  env: Env,
  row: TransferRow,
  index: number,
): Promise<void> {
  if (row.state !== "uploading") throw new HttpError(409, "conflict");
  if (index >= row.chunk_count) throw new HttpError(400, "invalid_chunk");
  requireType(request, "chunk");
  const length =
    index === row.chunk_count - 1
      ? row.cipher_bytes - index * (CHUNK_BYTES + ENVELOPE_OVERHEAD)
      : CHUNK_BYTES + ENVELOPE_OVERHEAD;
  const bytes = await boundedBody(request, length);
  if (bytes.length !== length) throw new HttpError(400, "invalid_chunk");
  const now = Date.now();
  const key = `${row.id}/${index}/${crypto.randomUUID()}`;
  const claim =
    await env.DB.prepare(`INSERT INTO chunks (transfer_id,chunk_index,object_key,state,bytes,started_at)
    SELECT id, ?, ?, 'writing', ?, ? FROM transfers
    WHERE id = ? AND state = 'uploading' AND expires_at > ? AND upload_deadline > ?
      AND NOT EXISTS (SELECT 1 FROM chunks WHERE transfer_id = ? AND chunk_index = ?)`)
      .bind(index, key, length, now, row.id, now, now, row.id, index)
      .run();
  if (claim.meta.changes === 0) {
    await authorized(request, env, row.id, "upload");
    throw new HttpError(409, "conflict");
  }
  // A writing lease is never expired by GC: a timeout cannot prove an R2 PUT has stopped.
  // If an isolate dies before settling the lease, fail closed and keep its reservation.
  try {
    const stored = await env.CIPHERTEXT.put(key, bytes, {
      onlyIf: new Headers({ "If-None-Match": "*" }),
      httpMetadata: { contentType: "application/octet-stream" },
    });
    if (!stored) throw new Error("immutable_object_exists");
  } catch {
    await env.DB.prepare(
      "UPDATE chunks SET state = 'failed' WHERE object_key = ? AND state = 'writing'",
    )
      .bind(key)
      .run();
    throw new HttpError(503, "storage_unavailable");
  }
  const settled = Date.now();
  const result = await env.DB.prepare(`UPDATE chunks SET state = CASE WHEN EXISTS
    (SELECT 1 FROM transfers WHERE id = ? AND state = 'uploading' AND expires_at > ? AND upload_deadline > ?)
    THEN 'stored' ELSE 'failed' END WHERE object_key = ? AND state = 'writing' RETURNING state`)
    .bind(row.id, settled, settled, key)
    .first<{ state: string }>();
  if (result?.state !== "stored") throw notFound();
}

export async function completeTransfer(
  request: Request,
  env: Env,
  row: TransferRow,
): Promise<{ id: string; expiresAt: number }> {
  const now = Date.now();
  await env.DB.prepare(`UPDATE transfers SET state = 'ready' WHERE id = ? AND state = 'uploading'
    AND expires_at > ? AND upload_deadline > ? AND chunk_count =
    (SELECT COUNT(*) FROM chunks WHERE transfer_id = ? AND state = 'stored')`)
    .bind(row.id, now, now, row.id)
    .run();
  const fresh = await authorized(request, env, row.id, "upload");
  if (fresh.state !== "ready") throw new HttpError(409, "incomplete");
  return { id: fresh.id, expiresAt: fresh.expires_at };
}
export async function readChunk(
  request: Request,
  env: Env,
  row: TransferRow,
  index: number,
): Promise<Response> {
  if (index >= row.chunk_count) throw notFound();
  const chunk = await env.DB.prepare(
    "SELECT * FROM chunks WHERE transfer_id = ? AND chunk_index = ? AND state = 'stored'",
  )
    .bind(row.id, index)
    .first<ChunkRow>();
  if (!chunk) throw notFound();
  const object = await env.CIPHERTEXT.get(chunk.object_key);
  // Recheck after R2 I/O. Do not send data whose authority was revoked while awaiting storage.
  await authorized(request, env, row.id, "read");
  if (!object || object.size !== chunk.bytes) throw notFound();
  return new Response(object.body, {
    headers: { "Content-Type": "application/octet-stream", "Content-Length": String(chunk.bytes) },
  });
}
export async function revoke(env: Env, id: string): Promise<void> {
  await env.DB.prepare("UPDATE transfers SET state = 'revoked' WHERE id = ? AND state != 'revoked'")
    .bind(id)
    .run();
}

// Bounded, retryable cleanup. Object identities stay durable until a confirmed delete.
// Rows become tombstones, never reusable IDs; reservation release is guarded and monotonic.
export async function cleanup(env: Env, now = Date.now()): Promise<void> {
  const candidates = await env.DB.prepare(`SELECT id FROM transfers WHERE reserved_bytes > 0
    AND (state = 'revoked' OR expires_at <= ? OR (state = 'uploading' AND upload_deadline <= ?))
    ORDER BY cleanup_at, created_at, id LIMIT 20`)
    .bind(now, now)
    .all<{ id: string }>();
  let remaining = 24;
  for (const { id } of candidates.results) {
    const mark =
      await env.DB.prepare(`UPDATE transfers SET state = 'revoked', cleanup_at = ? WHERE id = ? AND reserved_bytes > 0
      AND (state = 'revoked' OR expires_at <= ? OR (state = 'uploading' AND upload_deadline <= ?))`)
        .bind(now, id, now, now)
        .run();
    if (!mark.meta.changes) continue;
    const chunks = await env.DB.prepare(
      "SELECT * FROM chunks WHERE transfer_id = ? AND state != 'writing' ORDER BY chunk_index LIMIT ?",
    )
      .bind(id, remaining)
      .all<ChunkRow>();
    for (const chunk of chunks.results) {
      remaining--;
      try {
        await env.CIPHERTEXT.delete(chunk.object_key);
        if (await env.CIPHERTEXT.head(chunk.object_key)) continue;
        await env.DB.prepare(
          "DELETE FROM chunks WHERE object_key = ? AND state != 'writing' AND EXISTS (SELECT 1 FROM transfers WHERE id = ? AND state = 'revoked')",
        )
          .bind(chunk.object_key, id)
          .run();
      } catch {
        // Retain the exact object identity and full reservation for a later drain.
      }
    }
    await env.DB.prepare(`UPDATE transfers SET reserved_bytes = 0, encrypted_manifest = '', create_ip_key = '', create_day_key = ''
      WHERE id = ? AND state = 'revoked' AND reserved_bytes > 0 AND NOT EXISTS (SELECT 1 FROM chunks WHERE transfer_id = ?)`)
      .bind(id, id)
      .run();
  }
  await env.DB.prepare(
    "DELETE FROM rate_limits WHERE key IN (SELECT key FROM rate_limits WHERE expires_at <= ? ORDER BY expires_at LIMIT 200)",
  )
    .bind(now)
    .run();
}
