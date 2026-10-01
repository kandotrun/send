import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, readdir, rm, stat, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, expect, test } from "@playwright/test";

// Opt-in: transfers the FULL 10,000,000,000 bytes through native local D1/R2.
// Only the OS picker is substituted: the returned handle and writes are native OPFS.
// This does not establish real OS picker behavior or Safari/iPhone compatibility.
test("acceptance: full 10GB browser encryption, native storage and disk receive match SHA-256", async () => {
  test.skip(process.env.SEND_TEN_GB !== "1", "Explicit opt-in for a real 10GB disk/network test");
  test.setTimeout(3_600_000);
  const bytes = 10_000_000_000;
  const scratch = process.env.TMPDIR;
  if (!scratch) throw new Error("Use the session scratch directory");
  const directory = await mkdtemp(join(scratch, "send-ten-gb-"));
  const source = join(directory, "input.bin");
  const profile = join(directory, "browser");
  await writeFile(source, "");
  await truncate(source, bytes);
  const hashFile = async (path: string) => {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return hash.digest("hex");
  };
  const expectedHash = await hashFile(source);
  const context = await chromium.launchPersistentContext(profile, { headless: true });
  const started = Date.now();
  let peakMeasuredHeap = 0;
  let measurementIncludesBuffers = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  try {
    await context.addInitScript(() => {
      Object.defineProperty(window, "showSaveFilePicker", {
        configurable: true,
        value: async () => {
          const directory = await navigator.storage.getDirectory();
          return directory.getFileHandle("received.bin", { create: true });
        },
      });
    });
    const sender = await context.newPage();
    const base = `http://127.0.0.1:${process.env.SEND_E2E_PORT ?? "8809"}`;
    await sender.goto(base);
    await sender.locator("#file-input").setInputFiles(source);
    await expect(sender.locator("#selected-size")).toContainText("10 GB");
    const cdp = await context.newCDPSession(sender);
    timer = setInterval(() => {
      void cdp
        .send("Runtime.getHeapUsage")
        .then((usage) => {
          const detail = usage as typeof usage & { backingStorageSize?: number };
          measurementIncludesBuffers ||= typeof detail.backingStorageSize === "number";
          peakMeasuredHeap = Math.max(
            peakMeasuredHeap,
            detail.usedSize + (detail.backingStorageSize ?? 0),
          );
        })
        .catch(() => undefined);
    }, 1_000);
    await sender.locator("#send-button").click();
    await expect(sender.locator("#read-link")).toHaveValue(/#r=/, { timeout: 1_800_000 });
    // Keep capabilities in browser memory only. Never include them in test reports.
    const recipient = await context.newPage();
    await recipient.goto(await sender.locator("#read-link").inputValue());
    await expect(recipient.locator("#receive-size")).toContainText("10 GB");
    const receiverCdp = await context.newCDPSession(recipient);
    const sendCdp = cdp;
    clearInterval(timer);
    timer = setInterval(() => {
      for (const session of [sendCdp, receiverCdp])
        void session
          .send("Runtime.getHeapUsage")
          .then((usage) => {
            const detail = usage as typeof usage & { backingStorageSize?: number };
            measurementIncludesBuffers ||= typeof detail.backingStorageSize === "number";
            peakMeasuredHeap = Math.max(
              peakMeasuredHeap,
              detail.usedSize + (detail.backingStorageSize ?? 0),
            );
          })
          .catch(() => undefined);
    }, 1_000);
    await recipient.locator("#receiver-download").click();
    await expect(recipient.locator("#status-title")).toHaveText("ファイルを保存しました。", {
      timeout: 1_800_000,
    });
    expect(
      await recipient.evaluate(async () => {
        const root = await navigator.storage.getDirectory();
        const handle = await root.getFileHandle("received.bin");
        return (await handle.getFile()).size;
      }),
    ).toBe(bytes);
    clearInterval(timer);
    timer = undefined;
    await context.close();
    // Inspect only this test's isolated Chromium profile. Native OPFS keeps a
    // backing disk file; hashing it avoids loading 10GB into browser memory.
    const outputs: string[] = [];
    async function scan(path: string): Promise<void> {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        const child = join(path, entry.name);
        if (entry.isDirectory()) await scan(child);
        else if (entry.isFile() && (await stat(child)).size === bytes) outputs.push(child);
      }
    }
    await scan(profile);
    expect(outputs, "Expected exactly one native OPFS 10GB backing file").toHaveLength(1);
    const actualHash = await hashFile(outputs[0] as string);
    expect(actualHash).toBe(expectedHash);
    expect(peakMeasuredHeap).toBeLessThan(1_073_741_824);
    const report = {
      passed: true,
      plaintextBytes: bytes,
      encryptedChunks: Math.ceil(bytes / 4_194_304),
      sourceSha256: expectedHash,
      diskSha256: actualHash,
      elapsedSeconds: (Date.now() - started) / 1000,
      peakMeasuredHeap,
      measurement: measurementIncludesBuffers
        ? "CDP JS heap plus backing storage"
        : "CDP JS heap only; excludes external buffers",
      runtime: "Chromium, native local Worker/D1/R2, native OPFS disk; OS picker substituted",
    };
    await writeFile(
      join(scratch, "send-ten-gb-result.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    await rm(directory, { recursive: true, force: true });
  } finally {
    if (timer) clearInterval(timer);
    await context.close().catch(() => undefined);
  }
});
