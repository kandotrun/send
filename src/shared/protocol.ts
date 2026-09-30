export const VERSION = 1;
export const MAX_PLAIN_BYTES = 100_000_000;
export const CHUNK_BYTES = 4_194_304;
export const ENVELOPE_OVERHEAD = 28;
export const MAX_MANIFEST_BYTES = 8_192;
export const TTL_OPTIONS = [3_600, 86_400, 604_800] as const;
export type TtlSeconds = (typeof TTL_OPTIONS)[number];
export interface Manifest {
  version: 1;
  id: string;
  kind: "file" | "text";
  name: string;
  mime: string;
  size: number;
  chunkCount: number;
  chunkBytes: number;
  ttlSeconds: TtlSeconds;
}
export interface CreateRequest {
  id: string;
  readTokenHash: string;
  manageTokenHash: string;
  encryptedManifest: string;
  cipherBytes: number;
  chunkCount: number;
  ttlSeconds: TtlSeconds;
}
export interface TransferRecord {
  id: string;
  encryptedManifest: string;
  cipherBytes: number;
  chunkCount: number;
  expiresAt: number;
}
export interface ManageRecord {
  id: string;
  state: "uploading" | "ready" | "revoked";
  chunkCount: number;
  uploadedChunks: number;
  expiresAt: number;
}
export interface ReadLink {
  id: string;
  readToken: string;
  key: string;
}
export interface ManageLink {
  id: string;
  manageToken: string;
}
export interface TransferInput {
  blob: Blob;
  kind: "file" | "text";
  name: string;
  mime: string;
}
export interface Progress {
  stage: "encrypting" | "uploading" | "downloading";
  done: number;
  total: number;
}
export interface TransferOptions {
  signal?: AbortSignal;
  onProgress?: (progress: Progress) => void;
}
export interface CreatedTransfer {
  id: string;
  readUrl: string;
  manageUrl: string;
  expiresAt: number;
}
export interface OpenedTransfer {
  manifest: Manifest;
  expiresAt: number;
  download: (options?: TransferOptions) => Promise<Blob>;
}
