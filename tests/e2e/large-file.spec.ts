import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";

const size = 101_000_000;
const guide = "100 MBを超えるファイルの受け取りには、PC版ChromeまたはEdgeを使ってください。";
let readUrl: string;
let fixtureDir: string;

function chunkReads(page: Page): string[] {
  const reads: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "GET" &&
      /\/api\/transfers\/[^/]+\/chunks\//.test(new URL(request.url()).pathname)
    ) {
      reads.push(new URL(request.url()).pathname);
    }
  });
  return reads;
}

// OSダイアログだけを代替。暗号化・HTTP・Worker・D1/R2・OPFS一時書込み/commitは実装そのもの。
test.describe("spec: 101 MB native disk receive (controlled picker stub)", () => {
  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000);
    fixtureDir = await mkdtemp(join(tmpdir(), "send-large-ui-"));
    const path = join(fixtureDir, "native-save.bin");
    const output = await open(path, "wx");
    try {
      const bytes = Buffer.alloc(1_048_576);
      for (let offset = 0; offset < size; offset += bytes.length) {
        const length = Math.min(bytes.length, size - offset);
        for (let index = 0; index < length; index++) bytes[index] = (offset + index) % 251;
        await output.write(bytes.subarray(0, length));
      }
    } finally {
      await output.close();
    }
    const page = await browser.newPage();
    try {
      await page.goto("/");
      await expect(page.locator("#sender-browser-guide")).toContainText(guide);
      await page.locator("#file-input").setInputFiles(path);
      await expect(page.locator("#selected-size")).toHaveText("101 MB");
      await page.locator("#send-button").click();
      await expect(page.locator("#created-view")).toBeVisible({ timeout: 120_000 });
      readUrl = await page.locator("#read-link").inputValue();
    } finally {
      await page.close();
    }
  });

  test.afterAll(async () => {
    if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
  });

  test("unsupported browsers show fixed guidance and fetch no chunks", async ({ page }) => {
    const reads = chunkReads(page);
    await page.addInitScript(() => {
      Object.defineProperty(window, "showSaveFilePicker", { configurable: true, value: undefined });
    });
    await page.goto(readUrl);
    await expect(page.locator("#receiver-browser-guide")).toContainText(guide);
    await expect(page.locator("#status-detail")).toHaveText(guide);
    await expect(page.locator("#receiver-download")).toBeDisabled();
    expect(reads).toEqual([]);
  });

  test("cancelled picker shows fixed cancellation copy and fetches no chunks", async ({ page }) => {
    const reads = chunkReads(page);
    await page.addInitScript(() => {
      Object.defineProperty(window, "showSaveFilePicker", {
        configurable: true,
        value: () => Promise.reject(new DOMException("private/path SECRET", "AbortError")),
      });
    });
    await page.goto(readUrl);
    await expect(page.locator("#receiver-download")).toBeEnabled();
    await page.locator("#receiver-download").click();
    await expect(page.locator("#status")).toHaveAttribute("data-state", "cancelled");
    await expect(page.locator("#status-detail")).toHaveText(
      "保存先の選択または受け取りを中止しました。もう一度ボタンを押すと、はじめから受け取れます。",
    );
    await expect(page.locator("#status")).not.toContainText("SECRET");
    expect(reads).toEqual([]);
  });

  test("a stale picker cannot start saving into a new route", async ({ page }) => {
    const reads = chunkReads(page);
    await page.addInitScript(() => {
      const state = { pickerCalled: false, writableCalled: false, release: () => {} };
      Object.assign(window, { saveTest: state });
      Object.defineProperty(window, "showSaveFilePicker", {
        configurable: true,
        value: () => {
          state.pickerCalled = true;
          return new Promise((resolve) => {
            state.release = () =>
              resolve({
                createWritable: async () => {
                  state.writableCalled = true;
                  return new WritableStream();
                },
              });
          });
        },
      });
    });
    await page.goto(readUrl);
    await expect(page.locator("#receiver-download")).toBeEnabled();
    await page.locator("#receiver-download").click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { saveTest: { pickerCalled: boolean } }).saveTest.pickerCalled,
        ),
      )
      .toBe(true);
    await page.evaluate(() => {
      window.location.hash = "";
    });
    await expect(page.locator("#sender-view")).toBeVisible();
    await page.evaluate(async () => {
      (window as unknown as { saveTest: { release: () => void } }).saveTest.release();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { saveTest: { writableCalled: boolean } }).saveTest.writableCalled,
      ),
    ).toBe(false);
    await expect(page.locator("#status")).toBeHidden();
    expect(reads).toEqual([]);
  });

  test("a stale native createWritable is explicitly aborted before chunk reads", async ({
    page,
  }) => {
    const reads = chunkReads(page);
    await page.addInitScript(() => {
      const state = { acquired: false, aborted: false, release: () => {} };
      Object.assign(window, { saveTest: state });
      Object.defineProperty(window, "showSaveFilePicker", {
        configurable: true,
        value: async () => {
          const root = await navigator.storage.getDirectory();
          const handle = await root.getFileHandle("stale-save.bin", { create: true });
          return {
            createWritable: async () => {
              const native = await handle.createWritable();
              const writer = native.getWriter();
              const stream = new WritableStream({
                write: (chunk) => writer.write(chunk),
                close: () => writer.close(),
                abort: async () => {
                  await writer.abort();
                  state.aborted = true;
                },
              });
              state.acquired = true;
              return new Promise((resolve) => {
                state.release = () => resolve(stream);
              });
            },
          };
        },
      });
    });
    await page.goto(readUrl);
    await expect(page.locator("#receiver-download")).toBeEnabled();
    await page.locator("#receiver-download").click();
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as unknown as { saveTest: { acquired: boolean } }).saveTest.acquired,
        ),
      )
      .toBe(true);
    await page.evaluate(() => {
      window.location.hash = "";
    });
    await expect(page.locator("#sender-view")).toBeVisible();
    await page.evaluate(() =>
      (window as unknown as { saveTest: { release: () => void } }).saveTest.release(),
    );
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as unknown as { saveTest: { aborted: boolean } }).saveTest.aborted,
        ),
      )
      .toBe(true);
    expect(
      await page.evaluate(
        async () =>
          (
            await (
              await (await navigator.storage.getDirectory()).getFileHandle("stale-save.bin")
            ).getFile()
          ).size,
      ),
    ).toBe(0);
    await expect(page.locator("#status")).toBeHidden();
    expect(reads).toEqual([]);
  });

  test("streams authentic encrypted bytes to a real OPFS file without a Blob download", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const reads = chunkReads(page);
    let blobDownloads = 0;
    page.on("download", () => {
      blobDownloads++;
    });
    await page.addInitScript(() => {
      const state = { activation: false, suggestedName: "", filterKeys: [] as string[] };
      Object.assign(window, { saveTest: state });
      Object.defineProperty(window, "showSaveFilePicker", {
        configurable: true,
        value: async (options: { suggestedName: string }) => {
          state.activation = navigator.userActivation.isActive;
          state.suggestedName = options.suggestedName;
          state.filterKeys = Object.keys(options);
          const root = await navigator.storage.getDirectory();
          return root.getFileHandle("verified-save.bin", { create: true });
        },
      });
    });
    await page.goto(readUrl);
    await expect(page.locator("#receiver-download")).toBeEnabled();
    await page.locator("#receiver-download").click();
    await expect(page.locator("#status-title")).toHaveText("ファイルを保存しました。", {
      timeout: 120_000,
    });
    const result = await page.evaluate(async () => {
      const file = await (
        await (await navigator.storage.getDirectory()).getFileHandle("verified-save.bin")
      ).getFile();
      const reader = file.stream().getReader();
      let offset = 0;
      let equal = true;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (let index = 0; index < value.length; index++) {
          if (value[index] !== (offset + index) % 251) {
            equal = false;
            break;
          }
        }
        offset += value.length;
      }
      return {
        equal,
        length: offset,
        size: file.size,
        ...(window as unknown as { saveTest: object }).saveTest,
      };
    });
    expect(result).toEqual({
      equal: true,
      length: size,
      size,
      activation: true,
      suggestedName: "native-save.bin",
      filterKeys: ["suggestedName"],
    });
    expect(reads).toHaveLength(Math.ceil(size / 4_194_304));
    expect(blobDownloads).toBe(0);
    await expect(page.locator("#received-text-panel")).toBeHidden();
  });

  test("an injected disk quota failure aborts native temporary plaintext and shows storage guidance", async ({
    page,
  }) => {
    const reads = chunkReads(page);
    await page.addInitScript(() => {
      const state = { writes: 0, closed: false, aborted: false };
      Object.assign(window, { saveTest: state });
      Object.defineProperty(window, "showSaveFilePicker", {
        configurable: true,
        value: async () => {
          const root = await navigator.storage.getDirectory();
          const handle = await root.getFileHandle("failed-save.bin", { create: true });
          return {
            createWritable: async () => {
              const native = await handle.createWritable();
              const acquire = native.getWriter.bind(native);
              Object.defineProperty(native, "getWriter", {
                value: () => {
                  const writer = acquire();
                  const write = writer.write.bind(writer);
                  const close = writer.close.bind(writer);
                  const abort = writer.abort.bind(writer);
                  // Inject before native write, so the real native stream remains
                  // writable and client abort must discard its temporary plaintext.
                  Object.defineProperty(writer, "write", {
                    value: async (chunk: FileSystemWriteChunkType) => {
                      state.writes++;
                      if (state.writes === 2)
                        throw new DOMException("private disk path SECRET", "QuotaExceededError");
                      await write(chunk);
                    },
                  });
                  Object.defineProperty(writer, "close", {
                    value: async () => {
                      state.closed = true;
                      await close();
                    },
                  });
                  Object.defineProperty(writer, "abort", {
                    value: async () => {
                      await abort();
                      state.aborted = true;
                    },
                  });
                  return writer;
                },
              });
              return native;
            },
          };
        },
      });
    });
    await page.goto(readUrl);
    await expect(page.locator("#receiver-download")).toBeEnabled();
    await page.locator("#receiver-download").click();
    await expect(page.locator("#status")).toHaveAttribute("data-state", "error");
    await expect(page.locator("#status-detail")).toHaveText(
      "保存できませんでした。保存先の権限と空き容量（作業用領域を含む）を確認して、はじめから受け取り直してください。",
    );
    await expect(page.locator("#status")).not.toContainText("SECRET");
    expect(reads).toHaveLength(2);
    expect(
      await page.evaluate(async () => ({
        ...(window as unknown as { saveTest: object }).saveTest,
        size: (
          await (
            await (await navigator.storage.getDirectory()).getFileHandle("failed-save.bin")
          ).getFile()
        ).size,
      })),
    ).toEqual({ writes: 2, closed: false, aborted: true, size: 0 });
  });
});
