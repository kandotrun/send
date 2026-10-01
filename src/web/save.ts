import { transferErrorCode } from "../shared/errors.ts";
import {
  MAX_BUFFERED_BYTES,
  type Manifest,
  type OpenedTransfer,
  type TransferOptions,
} from "../shared/protocol.ts";
import { safeDownloadName } from "./presentation.ts";

export const LARGE_FILE_GUIDE =
  "100 MBを超えるファイルの受け取りには、PC版ChromeまたはEdgeを使ってください。";
const messages = {
  unsupported: LARGE_FILE_GUIDE,
  cancelled:
    "保存先の選択または受け取りを中止しました。もう一度ボタンを押すと、はじめから受け取れます。",
  storage:
    "保存できませんでした。保存先の権限と空き容量（作業用領域を含む）を確認して、はじめから受け取り直してください。",
} as const;
type SaveFailure = keyof typeof messages;
const trusted = new WeakMap<object, SaveFailure>();

class SaveError extends Error {
  constructor(code: SaveFailure) {
    super(messages[code]);
    trusted.set(this, code);
    Object.freeze(this);
  }
}

export interface NativeSaveHandle {
  createWritable(): Promise<WritableStream<Uint8Array<ArrayBuffer>>>;
}
export type SaveFilePicker = (options: { suggestedName: string }) => Promise<NativeSaveHandle>;
interface SaveOptions extends TransferOptions {
  isCurrent: () => boolean;
}

export function needsNativeSave(manifest: Pick<Manifest, "kind" | "size">): boolean {
  return manifest.kind === "file" && manifest.size > MAX_BUFFERED_BYTES;
}

export function supportsNativeSave(picker: unknown): picker is SaveFilePicker {
  return typeof picker === "function";
}

export function saveFailureCode(error: unknown): SaveFailure | undefined {
  return error !== null && typeof error === "object" ? trusted.get(error) : undefined;
}

export function saveFailureDetail(error: unknown): string | undefined {
  const code = saveFailureCode(error);
  return code ? messages[code] : undefined;
}

export async function saveLargeFile(
  transfer: OpenedTransfer,
  picker: SaveFilePicker | undefined,
  options: SaveOptions,
): Promise<void> {
  const current = () => options.isCurrent() && !options.signal?.aborted;
  if (!current()) throw new SaveError("cancelled");
  if (!supportsNativeSave(picker)) throw new SaveError("unsupported");
  let handle: NativeSaveHandle;
  try {
    // Called before the first await: the receive click still owns user activation.
    // Never derive picker types/extensions from untrusted MIME metadata.
    handle = await picker({ suggestedName: safeDownloadName(transfer.manifest.name) });
  } catch (error) {
    const cancelled = !current() || (error instanceof DOMException && error.name === "AbortError");
    throw new SaveError(cancelled ? "cancelled" : "storage");
  }
  if (!current()) throw new SaveError("cancelled");
  let sink: WritableStream<Uint8Array<ArrayBuffer>>;
  try {
    // Native FileSystemWritableFileStream writes transactionally until client close.
    sink = await handle.createWritable();
  } catch {
    throw new SaveError(current() ? "storage" : "cancelled");
  }
  if (!current()) {
    try {
      await sink.abort();
    } catch {
      /* Never commit a stale temporary write, even if cleanup reports failure. */
    }
    throw new SaveError("cancelled");
  }
  try {
    // Ownership passes to the client: it closes only on success and aborts on failure.
    await transfer.downloadTo(sink, { signal: options.signal, onProgress: options.onProgress });
  } catch (error) {
    if (!current()) throw new SaveError("cancelled");
    const code = transferErrorCode(error);
    if (code !== undefined && code !== "unknown") throw error;
    throw new SaveError("storage");
  }
  if (!current()) throw new SaveError("cancelled");
}
