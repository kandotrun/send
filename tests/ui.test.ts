import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = (path: string) =>
  existsSync(`${root}${path}`) ? readFileSync(`${root}${path}`, "utf8") : "";
const html = source("index.html");
const main = source("src/web/main.ts");
const css = source("src/web/style.css").replace(/\/\*[\s\S]*?\*\//g, "");

// 静的な配信面の仕様。実ブラウザーと実APIの往復は別のE2Eが検証する。
describe("spec: Japanese transfer stationery", () => {
  it("places a usable single-file and text form in the first screen", () => {
    expect(html).toContain('id="send-form"');
    for (const id of [
      "file-tab",
      "text-tab",
      "dropzone",
      "file-input",
      "file-clear",
      "text-input",
    ]) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).toContain("100 MB");
    expect(html).toContain("ファイルを選ぶ");
    expect(html).toContain('type="file"');
    expect(html).not.toMatch(/<input[^>]*\bmultiple\b/);
    expect(html).toContain('role="tablist"');
    expect(html).toContain('role="tabpanel"');
    expect(html).toContain('id="send-button"');
    expect(html).toContain("共有リンクをつくる");
  });

  it("offers the fixed TTLs with a 24-hour default", () => {
    expect(html).toContain('for="expiry"');
    expect(html).toMatch(/<option value="3600">1時間<\/option>/);
    expect(html).toMatch(/<option value="86400" selected>24時間<\/option>/);
    expect(html).toMatch(/<option value="604800">7日<\/option>/);
  });

  it("provides an in-flow live progress region and a real cancel hook", () => {
    expect(html).toContain('id="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('id="operation-progress"');
    expect(html).toContain('id="cancel-button"');
    expect(main).toContain("new AbortController()");
    expect(main).toContain(".abort()");
    expect(main).toContain("onProgress:");
    expect(main).toContain("signal:");
    expect(main).toContain("fieldset.disabled = busy");
    expect(main).toContain("status.dataset.state = state");
    expect(html).toContain('data-testid="dropzone"');
  });

  it("connects genuine drag events and the picker to the same validation path", () => {
    for (const event of ["dragenter", "dragover", "dragleave", "drop"]) {
      expect(main).toMatch(new RegExp(`['"]${event}['"]`));
    }
    expect(main).toContain("event.preventDefault()");
    expect(main).toContain("acceptFiles(fileInput.files)");
    expect(main).toContain("acceptFiles(event.dataTransfer");
    expect(main).toContain("validateFiles(");
  });

  it("keeps read and management capabilities visibly separate", () => {
    expect(html).toContain('for="read-link"');
    expect(html).toContain("共有リンク");
    expect(html).toContain('for="manage-link"');
    expect(html).toContain("管理リンク");
    expect(html).toMatch(/id="read-link"[^>]*readonly/);
    expect(html).toMatch(/id="manage-link"[^>]*readonly/);
    for (const id of ["copy-read", "copy-manage", "created-expiry", "new-send", "revoke-created"]) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).toContain(
      "共有リンクを知っている人は受け取れます。管理リンクは送らず、自分で保管してください。",
    );
  });

  it("has explicit receiver actions and a management-only surface", () => {
    for (const id of [
      "receiver-view",
      "receive-name",
      "receive-size",
      "receive-expiry",
      "receiver-download",
      "received-text",
      "copy-text",
      "download-text",
      "management-view",
      "management-state",
      "management-expiry",
      "revoke-button",
      "invalid-view",
    ]) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(main).toMatch(/from ['"]\.\.\/client\/transfer\.ts['"]/);
    for (const call of ["createTransfer(", "openTransfer(", "getManagement(", "revokeTransfer("]) {
      expect(main).toContain(call);
    }
    expect(main).toContain("parseReadLink(window.location.href)");
    expect(main).toContain("parseManageLink(window.location.href)");
    expect(main).toContain("URL.createObjectURL(blob)");
    expect(main).toContain("URL.revokeObjectURL(");
    expect(main).toContain("textContent =");
    expect(main).not.toMatch(/\binnerHTML\b|\blocalStorage\b|\bsessionStorage\b|console\./);
    expect(html).not.toMatch(/<iframe|<object|<embed|<img[^>]*receive/i);
  });

  it("explains the actual security limits without absolute promises", () => {
    for (const copy of [
      "内容とファイル名は、この端末で暗号化",
      "受け取った相手が保存したコピーは取り消せません",
      "リンクを持つ人は、ほかの人に転送できます",
      "サイズ・期限・IPアドレス",
      "ウイルス検査は行っていません。信頼できる相手からのファイルだけ開いてください。",
      "第三者によるセキュリティ監査は未実施",
      "配信されるJavaScript",
      "端末や拡張機能",
    ]) {
      expect(html).toContain(copy);
    }
    expect(html).toContain('id="security-details"');
    expect(html).toContain("https://github.com/kandotrun/send");
    expect(html).not.toMatch(/完全に安全|絶対に|100%安全/);
  });

  it("uses only self-hosted assets and accessible responsive styling", () => {
    expect(html).toContain('lang="ja"');
    expect(html).toContain('name="viewport"');
    expect(html).toContain('name="referrer" content="no-referrer"');
    expect(html).toContain('<script type="module" src="/src/web/main.ts"></script>');
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)|\sonclick=|\sstyle=/);
    expect(css).toMatch(/\[hidden\]\s*\{\s*display:\s*none\s*!important/);
    expect(css).toContain("prefers-reduced-motion: reduce");
    expect(css).toContain(":focus-visible");
    expect(css).toContain("min-width: 0");
    expect(css).not.toContain("@import");
    expect(source("public/favicon.svg")).toContain("<svg");
  });
});

// 純粋な境界処理はブラウザーなしでも実装そのものを検証できる。
describe("spec: UI input boundaries", () => {
  async function helpers() {
    expect(source("src/web/presentation.ts")).toContain("export function validateFiles");
    return import("../src/web/presentation.ts");
  }

  it("accepts exactly one file at the limit, including empty files", async () => {
    const { validateFiles } = await helpers();
    expect(validateFiles([{ size: 100_000_000 }])).toBeNull();
    expect(validateFiles([{ size: 0 }])).toBeNull();
    expect(validateFiles([{ size: 100_000_001 }])).toBe("ファイルは100 MBまでです。");
    expect(validateFiles([{ size: 1 }, { size: 1 }])).toBe("一度に送れるファイルは1個です。");
    expect(validateFiles([])).toBe("ファイルを1個選んでください。");
  });

  it("never retains a previous file when replacement input is invalid", async () => {
    expect(source("src/web/presentation.ts")).toContain("export function resolveFiles");
    const { resolveFiles } = await helpers();
    const valid = { size: 5, name: "first.txt" };
    expect(resolveFiles([valid])).toEqual({ file: valid, error: null });
    expect(resolveFiles([valid, valid])).toEqual({
      file: null,
      error: "一度に送れるファイルは1個です。",
    });
    expect(resolveFiles([{ size: 100_000_001 }]).file).toBeNull();
    expect(main).toContain("selectedFile = selection.file");
  });

  it("validates the exact UTF-8 text size and does not trim the content", async () => {
    const { validateText } = await helpers();
    expect(validateText("")).toBe("文章を入力してください。");
    expect(validateText("  \n")).toBeNull();
    expect(validateText("あ", 3)).toBeNull();
    expect(validateText("あ", 2)).toBe("文章は100 MBまでです。");
  });

  it("rejects nonprotocol TTLs rather than silently normalizing values", async () => {
    const { parseTtl } = await helpers();
    expect(parseTtl("3600")).toBe(3600);
    expect(parseTtl("86400")).toBe(86400);
    expect(parseTtl("604800")).toBe(604800);
    expect(() => parseTtl("1")).toThrow();
    expect(() => parseTtl("086400")).toThrow();
  });

  it("formats an absolute local expiry including seconds and timezone", async () => {
    const { formatExpiry } = await helpers();
    const timestamp = Date.UTC(2026, 8, 30, 12, 34, 56);
    const formatted = formatExpiry(timestamp);
    expect(formatted).toMatch(/2026/);
    expect(formatted).toMatch(/\d{2}:\d{2}:56/);
    expect(formatted).toContain(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(formatExpiry(Number.NaN)).toBe("期限を確認できません");
  });

  it("strips dangerous path characters from saved names without evaluating them", async () => {
    const { safeDownloadName } = await helpers();
    expect(safeDownloadName("../../report\u0000.txt")).toBe(".._.._report_.txt");
    expect(safeDownloadName("")).toBe("download");
    expect(safeDownloadName("<img onerror=alert(1)>.txt")).toBe("<img onerror=alert(1)>.txt");
  });
});
