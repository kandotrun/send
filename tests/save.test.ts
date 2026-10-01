import { existsSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { TransferError } from "../src/shared/errors.ts";
import type { OpenedTransfer } from "../src/shared/protocol.ts";

const guide = "100 MBを超えるファイルの受け取りには、PC版ChromeまたはEdgeを使ってください。";
const cancelled =
  "保存先の選択または受け取りを中止しました。もう一度ボタンを押すと、はじめから受け取れます。";
const storage =
  "保存できませんでした。保存先の権限と空き容量（作業用領域を含む）を確認して、はじめから受け取り直してください。";

async function helpers() {
  expect(existsSync(new URL("../src/web/save.ts", import.meta.url))).toBe(true);
  return import("../src/web/save.ts");
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function transfer(size = 100_000_001, kind: "file" | "text" = "file"): OpenedTransfer {
  return {
    manifest: {
      version: 1,
      id: "synthetic-id",
      kind,
      name: "../../report\u0000.svg",
      mime: "text/html;garbage",
      size,
      chunkCount: 24,
      chunkBytes: 4_194_304,
      ttlSeconds: 3600,
    },
    expiresAt: Date.now() + 3600_000,
    download: vi.fn(async () => new Blob()),
    downloadTo: vi.fn(async (sink) => {
      const writer = sink.getWriter();
      await writer.write(new Uint8Array([1, 2, 3]));
      await writer.close();
      writer.releaseLock();
    }),
  };
}

// ピッカーと遅延境界だけを代替。実WritableStreamを使い、暗号・実ディスクは別のE2Eで検証する。
describe("spec: bounded native save UI", () => {
  it("uses native saves only for files above the exact buffered boundary", async () => {
    const { needsNativeSave } = await helpers();
    expect(needsNativeSave(transfer(100_000_000).manifest)).toBe(false);
    expect(needsNativeSave(transfer(100_000_001).manifest)).toBe(true);
    expect(needsNativeSave(transfer(100_000_001, "text").manifest)).toBe(false);
  });

  it("detects the picker capability without promising unsupported browser saves", async () => {
    const { supportsNativeSave } = await helpers();
    expect(supportsNativeSave(undefined)).toBe(false);
    expect(supportsNativeSave(null)).toBe(false);
    expect(supportsNativeSave(() => Promise.reject())).toBe(true);
  });

  it("rejects unsupported receivers before invoking any client download", async () => {
    const { saveLargeFile, saveFailureDetail } = await helpers();
    const opened = transfer();
    const error = await saveLargeFile(opened, undefined, { isCurrent: () => true }).catch(
      (e: unknown) => e,
    );
    expect(saveFailureDetail(error)).toBe(guide);
    expect(opened.download).not.toHaveBeenCalled();
    expect(opened.downloadTo).not.toHaveBeenCalled();
  });

  it("opens the picker synchronously with a sanitized name and no untrusted MIME filters", async () => {
    const { saveLargeFile } = await helpers();
    const opened = transfer();
    const written: Uint8Array[] = [];
    const close = vi.fn();
    const abort = vi.fn();
    const sink = new WritableStream<Uint8Array<ArrayBuffer>>({
      write: (chunk) => {
        written.push(chunk);
      },
      close,
      abort,
    });
    const picker = vi.fn(async () => ({ createWritable: async () => sink }));
    const operation = saveLargeFile(opened, picker, { isCurrent: () => true });
    expect(picker).toHaveBeenCalledExactlyOnceWith({ suggestedName: ".._.._report_.svg" });
    await operation;
    expect(written).toEqual([new Uint8Array([1, 2, 3])]);
    expect(close).toHaveBeenCalledTimes(1);
    expect(abort).not.toHaveBeenCalled();
    expect(opened.download).not.toHaveBeenCalled();
  });

  it("maps picker cancellation to fixed copy without initiating chunk downloads", async () => {
    const { saveLargeFile, saveFailureDetail } = await helpers();
    const opened = transfer();
    const picker = () => Promise.reject(new DOMException("private/path secret", "AbortError"));
    const error = await saveLargeFile(opened, picker, { isCurrent: () => true }).catch(
      (e: unknown) => e,
    );
    expect(saveFailureDetail(error)).toBe(cancelled);
    expect(opened.downloadTo).not.toHaveBeenCalled();
  });

  it("does not acquire a writable after a stale picker returns", async () => {
    const { saveLargeFile } = await helpers();
    const opened = transfer();
    const handle = deferred<{
      createWritable: () => Promise<WritableStream<Uint8Array<ArrayBuffer>>>;
    }>();
    let current = true;
    const createWritable = vi.fn(async () => new WritableStream<Uint8Array<ArrayBuffer>>());
    const operation = saveLargeFile(opened, () => handle.promise, { isCurrent: () => current });
    current = false;
    handle.resolve({ createWritable });
    await expect(operation).rejects.toThrow();
    expect(createWritable).not.toHaveBeenCalled();
    expect(opened.downloadTo).not.toHaveBeenCalled();
  });

  it("aborts an acquired writable after a route change during createWritable", async () => {
    const { saveLargeFile } = await helpers();
    const opened = transfer();
    const writable = deferred<WritableStream<Uint8Array<ArrayBuffer>>>();
    const createWritable = vi.fn(() => writable.promise);
    const abort = vi.fn();
    let current = true;
    const operation = saveLargeFile(opened, async () => ({ createWritable }), {
      isCurrent: () => current,
    });
    await vi.waitFor(() => expect(createWritable).toHaveBeenCalled());
    current = false;
    writable.resolve(new WritableStream({ abort }));
    await expect(operation).rejects.toThrow();
    expect(abort).toHaveBeenCalledTimes(1);
    expect(opened.downloadTo).not.toHaveBeenCalled();
  });

  it("aborts an acquired writable after cancellation before client ownership", async () => {
    const { saveLargeFile } = await helpers();
    const opened = transfer();
    const writable = deferred<WritableStream<Uint8Array<ArrayBuffer>>>();
    const active = new AbortController();
    const abort = vi.fn();
    const createWritable = vi.fn(() => writable.promise);
    const operation = saveLargeFile(opened, async () => ({ createWritable }), {
      signal: active.signal,
      isCurrent: () => true,
    });
    await vi.waitFor(() => expect(createWritable).toHaveBeenCalled());
    active.abort();
    writable.resolve(new WritableStream({ abort }));
    await expect(operation).rejects.toThrow();
    expect(abort).toHaveBeenCalledTimes(1);
    expect(opened.downloadTo).not.toHaveBeenCalled();
  });

  it("checks the route after downloadTo resolves and preserves client stream ownership", async () => {
    const { saveLargeFile } = await helpers();
    const opened = transfer();
    const completion = deferred<void>();
    opened.downloadTo = vi.fn(() => completion.promise);
    const abort = vi.fn();
    const sink = new WritableStream<Uint8Array<ArrayBuffer>>({ abort });
    let current = true;
    const operation = saveLargeFile(opened, async () => ({ createWritable: async () => sink }), {
      isCurrent: () => current,
    });
    await vi.waitFor(() => expect(opened.downloadTo).toHaveBeenCalled());
    current = false;
    completion.resolve();
    await expect(operation).rejects.toThrow();
    expect(abort).not.toHaveBeenCalled();
  });

  it("maps native permission and quota failures to storage guidance without raw errors", async () => {
    const { saveLargeFile, saveFailureDetail } = await helpers();
    for (const phase of ["picker", "writable"]) {
      const failure = new DOMException("/private/file #r=secret", "NotAllowedError");
      const picker =
        phase === "picker"
          ? () => Promise.reject(failure)
          : async () => ({ createWritable: () => Promise.reject(failure) });
      const error = await saveLargeFile(transfer(), picker, { isCurrent: () => true }).catch(
        (e: unknown) => e,
      );
      expect(saveFailureDetail(error)).toBe(storage);
    }
    expect(saveFailureDetail({ message: "/private/file", code: "storage" })).toBeUndefined();
  });

  it("maps sink failures to storage guidance but retains trusted network and decrypt errors", async () => {
    const { saveLargeFile, saveFailureDetail } = await helpers();
    for (const failure of [
      new Error("private quota"),
      new TransferError("unknown"),
      new TransferError("network"),
      new TransferError("decryption"),
    ]) {
      const opened = transfer();
      opened.downloadTo = vi.fn(async () => {
        throw failure;
      });
      const error = await saveLargeFile(
        opened,
        async () => ({ createWritable: async () => new WritableStream() }),
        { isCurrent: () => true },
      ).catch((e: unknown) => e);
      if (failure instanceof TransferError && failure.code !== "unknown")
        expect(error).toBe(failure);
      else expect(saveFailureDetail(error)).toBe(storage);
    }
  });
});
